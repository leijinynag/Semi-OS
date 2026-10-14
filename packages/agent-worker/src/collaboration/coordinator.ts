import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseWorkflowSnapshot,
  type JsonValue,
  type WorkflowSnapshot,
  type RequestId,
} from "@semi-os/protocol";
import type { ToolDefinition } from "@semi-os/tool-sdk";
import type { AgentCheckpoint, AgentRuntimeAdapter } from "../runtime.ts";
import type { WorkflowHost } from "./workflow-host.ts";

export interface CoordinatorOptions {
  host: Pick<WorkflowHost, "request">;
  directory: string;
  runtime(snapshot: WorkflowSnapshot): AgentRuntimeAdapter;
  tools(snapshot: WorkflowSnapshot): ToolDefinition[];
  restoreQueued?(snapshot: WorkflowSnapshot, signal: AbortSignal): Promise<void>;
  retryDelays?: readonly number[];
}
interface ActiveTurn {
  abort: AbortController;
  runtime?: AgentRuntimeAdapter;
  taskId: string;
  operation: Promise<void>;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
function checkpoint(value: unknown, sessionId: string): AgentCheckpoint | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    value.sessionId !== sessionId ||
    !("sequence" in value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object" ||
    Array.isArray(value.data)
  )
    throw new Error("Invalid coordinator checkpoint");
  return value as AgentCheckpoint;
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("Coordinator stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * 每个工作流的持久 Pi 协调器。不实现智能编排循环，只有 Host 事件驱动 Pi 官方轮次。
 * 领取/提交可幂等重试；模型调用和工具执行不可重放，失败保留现场等待核对。
 */
export class WorkflowCoordinator {
  readonly #options: CoordinatorOptions;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #pending = new Set<string>();
  #disposed = false;
  constructor(options: CoordinatorOptions) {
    this.#options = options;
  }

  wake(workflowId: string): void {
    if (this.#disposed) return;
    this.#pending.add(workflowId);
    if (this.#active.has(workflowId)) return;
    const turn: ActiveTurn = {
      abort: new AbortController(),
      taskId: `coord_${randomUUID()}`,
      operation: Promise.resolve(),
    };
    this.#pending.delete(workflowId);
    this.#active.set(workflowId, turn);
    turn.operation = this.#run(workflowId, turn)
      .catch(() => {
        process.stderr.write("[agent-worker] coordinator_needs_reconciliation\n");
      })
      .finally(() => {
        this.#active.delete(workflowId);
        if (this.#pending.has(workflowId)) this.wake(workflowId);
      });
  }

  async stop(workflowId: string): Promise<void> {
    this.#pending.delete(workflowId);
    const turn = this.#active.get(workflowId);
    if (!turn) return;
    turn.abort.abort();
    await turn.runtime?.abort(turn.taskId).catch(() => {});
    await turn.operation;
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#pending.clear();
    await Promise.all([...this.#active.keys()].map((id) => this.stop(id)));
  }
  async settled(workflowId: string): Promise<void> {
    while (this.#active.has(workflowId)) await this.#active.get(workflowId)!.operation;
  }

  async #safe(operation: string, value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const delays = this.#options.retryDelays ?? [2_000, 10_000, 30_000];
    const requestId = `req_coordinator_${randomUUID().replaceAll("-", "")}` as RequestId;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#options.host.request(operation, value, signal, requestId);
      } catch (cause) {
        // 只重试通信失败；Host 明确拒绝不可反复请求。
        if (
          signal.aborted ||
          attempt >= delays.length ||
          !(cause instanceof Error) ||
          !/transport unavailable|acknowledgement timed out/i.test(cause.message)
        )
          throw cause;
        await delay(delays[attempt]!, signal);
      }
    }
  }

  async #run(workflowId: string, turn: ActiveTurn): Promise<void> {
    const owner = `coordinator_${randomUUID()}`;
    const signal = turn.abort.signal;
    let claimed: JsonValue;
    try {
      claimed = await this.#safe("coordinator.claim", { workflowId, owner }, signal);
    } catch (cause) {
      if (
        !signal.aborted &&
        cause instanceof Error &&
        /transport unavailable|acknowledgement timed out/i.test(cause.message)
      ) {
        // 领取结果可能已保存。Host 只允许标记本 owner，不重复调用模型或抢别人的轮次。
        await this.#safe(
          "coordinator.unavailable",
          { workflowId, owner },
          new AbortController().signal,
        );
      }
      throw cause;
    }
    if (
      !claimed ||
      typeof claimed !== "object" ||
      Array.isArray(claimed) ||
      claimed.claimed !== true
    )
      return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let renewal = Promise.resolve();
    let runtimeError = false;
    try {
      const snapshot = parseWorkflowSnapshot(claimed.snapshot);
      if (
        snapshot.plan.workflowId !== workflowId ||
        !Number.isSafeInteger(claimed.sequence) ||
        !Array.isArray(claimed.events)
      )
        throw new Error("Invalid coordinator claim");
      const sequence = Number(claimed.sequence);
      const sessionId = `coordinator_${workflowId}`;
      const cwd = join(this.#options.directory, workflowId);
      await mkdir(cwd, { recursive: true });
      signal.throwIfAborted();
      timer = setInterval(() => {
        renewal = renewal
          .then(async () => {
            if (signal.aborted) return;
            await this.#safe("coordinator.renew", { workflowId, owner }, signal);
          })
          .catch(() => {
            turn.abort.abort();
            void turn.runtime?.abort(turn.taskId).catch(() => {});
          });
      }, 25_000);
      timer.unref();
      await this.#options.restoreQueued?.(snapshot, signal);
      const runtime = this.#options.runtime(snapshot);
      turn.runtime = runtime;
      unsubscribe = runtime.subscribe((event) => {
        if (event.kind === "runtime.error") runtimeError = true;
      });
      await runtime.startSession({
        sessionId,
        cwd,
        tools: this.#options.tools(snapshot),
        checkpoint: checkpoint(claimed.checkpoint, sessionId),
      });
      signal.throwIfAborted();
      await runtime.prompt({
        taskId: turn.taskId,
        text: [
          "推进此已批准工作流。先观察真实快照，再决定分工、返工、整合及验证。不能重放已存在或未知的尝试。",
          "用户最新指令最高优先。只能在真人授权的范围内决定细节；新增需求、偏好、权限必须交给用户。",
          "有执行中子任务时可结束本轮等待持久事件，不持续轮询。完成必须绑定真实整合提交、通过的测试及独立审查。",
          `工作流：${JSON.stringify(snapshot)}\n待处理事件：${JSON.stringify(claimed.events)}`,
        ].join("\n"),
      });
      signal.throwIfAborted();
      if (runtimeError) throw new Error("Coordinator runtime failed");
      if (timer) clearInterval(timer);
      await renewal;
      await this.#safe(
        "coordinator.finish",
        {
          workflowId,
          owner,
          sequence,
          checkpoint: json(await runtime.checkpoint()),
          progress: true,
        },
        signal,
      );
      // 排空本轮产生的持久事件；无事件的领取返回 false，不形成模型轮询。
      this.#pending.add(workflowId);
    } catch {
      await this.#safe(
        "coordinator.fail",
        { workflowId, owner },
        new AbortController().signal,
      ).catch(() => {});
    } finally {
      if (timer) clearInterval(timer);
      await renewal;
      unsubscribe?.();
      await turn.runtime?.dispose();
    }
  }
}
