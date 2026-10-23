import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import {
  parseAgentRun,
  parseWorkflowSnapshot,
  parseIntegrationResult,
  parseReviewFinding,
  parseWorkflowApplication,
  hasCapability,
  isIntegrationWorkItem,
  isWritingWorkItem,
  type AgentRun,
  type CodingProvider,
  type WorkflowSnapshot,
  type JsonValue,
  type IntegrationResult,
} from "@semi-os/protocol";
import { runTest } from "./test-runner.ts";
import type { WorkflowHost } from "./workflow-host.ts";
import { WorkspaceService, NeedsUserError } from "./workspaces.ts";
import { PiCodingProvider } from "./pi-provider.ts";
import { ClaudeCodingProvider } from "./claude-provider.ts";
import { CodexCodingProvider } from "./codex-provider.ts";
import type {
  CodingProviderPort,
  ProviderEvent,
  ProviderFactory,
  ProviderPermission,
  ProviderDecision,
} from "./provider.ts";
import type { ResearchHost } from "../research-host.ts";

interface Execution {
  run: AgentRun;
  snapshot: WorkflowSnapshot;
  provider?: CodingProviderPort;
  abort: AbortController;
  events: Promise<void>;
  permissions: Promise<void>;
  released?: boolean;
  active?: boolean;
  starting?: Promise<void>;
  resume?: { sessionId: string; revision: string };
  integrationCommits?: string[];
  lastActivityAt?: number;
  healthTimer?: ReturnType<typeof setInterval>;
  stalled?: boolean;
}
const providers: Record<CodingProvider, () => CodingProviderPort> = {
  pi: () => new PiCodingProvider(),
  claude: () => new ClaudeCodingProvider(),
  codex: () => new CodexCodingProvider(),
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const MAX_ACTIVE_CHILDREN = 2;

/** 仅调度主 Pi 已派发的工作项；资源释放不创建新任务，不自行调用模型决定下一步。 */
export class CollaborationService {
  readonly #executions = new Map<string, Execution>();
  readonly #queue: Execution[] = [];
  #active = 0;
  readonly #activeByWorkflow = new Map<string, number>();
  #disposed = false;
  readonly host: Pick<WorkflowHost, "list" | "authorize" | "request">;
  readonly policy: Pick<ResearchHost, "authorize">;
  readonly workspaces: Pick<
    WorkspaceService,
    "create" | "deliver" | "integrate" | "revision" | "diff" | "restore"
  > &
    Partial<Pick<WorkspaceService, "applicationTarget" | "apply">>;
  readonly factory: ProviderFactory;
  readonly healthTimeoutMs: number;
  readonly #applying = new Set<string>();
  readonly #decisions = new Map<string, (value: Record<string, unknown> | null) => void>();
  constructor(
    host: CollaborationService["host"],
    policy: CollaborationService["policy"],
    workspaces: CollaborationService["workspaces"] = new WorkspaceService(
      join(homedir(), ".semi-os", "worktrees"),
    ),
    factory: ProviderFactory = (provider) => providers[provider](),
    healthTimeoutMs = 120_000,
  ) {
    this.host = host;
    this.policy = policy;
    this.workspaces = workspaces;
    this.factory = factory;
    this.healthTimeoutMs = healthTimeoutMs;
  }

  /** 只续排 Host 确认从未发送启动请求的旧尝试；保留原 runId，不创建替代现场。 */
  async restoreQueued(snapshot: WorkflowSnapshot, signal: AbortSignal): Promise<void> {
    if (snapshot.status !== "approved") return;
    for (const run of snapshot.runs) {
      if (
        run.status !== "queued" ||
        run.intentVersion !== snapshot.plan.intentVersion ||
        this.#executions.has(run.runId)
      )
        continue;
      const phase = await this.host.request("run.phase.read", { runId: run.runId }, signal);
      if (phase !== "not_started" || run.workspace) continue;
      const execution: Execution = {
        run: { ...run },
        snapshot,
        abort: new AbortController(),
        events: Promise.resolve(),
        permissions: Promise.resolve(),
      };
      this.#executions.set(run.runId, execution);
      this.#queue.push(execution);
    }
    this.#drain();
  }

  async dispatch(
    session: string,
    workflowId: string,
    workItemId: string,
    signal: AbortSignal,
    resumeRunId?: string,
  ): Promise<AgentRun> {
    if (this.#applying.has(workflowId))
      throw new NeedsUserError("成果应用中，不能启动新的执行尝试");
    const snapshot = (await this.host.list(session, signal)).find(
      (item) => item.plan.workflowId === workflowId,
    );
    if (!snapshot) throw new Error("未知工作流");
    const item = snapshot.plan.workItems.find((item) => item.workItemId === workItemId);
    if (!item) throw new Error("未知工作项");
    await this.host.authorize(
      workflowId,
      snapshot.plan.version,
      snapshot.digest,
      workItemId,
      signal,
    );
    const current = snapshot.runs.filter(
      (run) => run.intentVersion === snapshot.plan.intentVersion,
    );
    if (
      current.some(
        (run) =>
          run.workItemId === workItemId &&
          ["queued", "running", "blocked", "unknown"].includes(run.status),
      )
    )
      throw new Error("工作项已有未结束或待核对尝试");
    for (const dependency of item.dependencies) {
      if (current.filter((run) => run.workItemId === dependency).at(-1)?.status !== "completed")
        throw new Error("依赖尚未完成");
    }
    const run: AgentRun = {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      workflowId,
      workItemId,
      planVersion: snapshot.plan.version,
      intentVersion: snapshot.plan.intentVersion,
      provider: item.provider,
      attempt: current.filter((run) => run.workItemId === workItemId).length + 1,
      status: "queued",
      startedAtMs: Date.now(),
      capabilities: this.factory(item.provider).capabilities,
    };
    let resume: Execution["resume"];
    if (resumeRunId) {
      const previous = current.find(
        (run) => run.runId === resumeRunId && run.workItemId === workItemId,
      );
      if (
        !previous ||
        !["cancelled", "failed"].includes(previous.status) ||
        !previous.providerSessionId ||
        previous.provider !== item.provider ||
        !this.factory(item.provider).capabilities.resume
      )
        throw new NeedsUserError("该尝试不支持续接，或需先核对停止结果");
      await this.workspaces.restore(snapshot.plan, previous);
      // 只能从干净、明确的成果版本续接；未提交成果不能被新工作区静默遗漏。
      resume = {
        sessionId: previous.providerSessionId,
        revision: await this.workspaces.revision(previous.workspace!),
      };
    }
    const execution: Execution = {
      run,
      snapshot,
      resume,
      abort: new AbortController(),
      events: Promise.resolve(),
      permissions: Promise.resolve(),
    };
    await this.#save(execution);
    if (resumeRunId)
      await this.host.request(
        "event",
        {
          workflowId,
          kind: "run.resumed",
          summary: `${workItemId} · 新尝试续接 ${resumeRunId} 的会话，基线 ${resume!.revision}`,
        },
        signal,
      );
    this.#executions.set(run.runId, execution);
    this.#queue.push(execution);
    this.#drain();
    return { ...run };
  }

  #drain(): void {
    // 计划预算约束单个工作流；全局名额避免多个后台工作流一起耗尽本机资源。
    while (!this.#disposed && this.#active < MAX_ACTIVE_CHILDREN && this.#queue.length) {
      const index = this.#queue.findIndex((execution) => {
        const limit = execution.snapshot.plan.executionBudget.maxParallelRuns;
        return (this.#activeByWorkflow.get(execution.run.workflowId) ?? 0) < limit;
      });
      if (index < 0) return;
      const execution = this.#queue.splice(index, 1)[0]!;
      if (execution.abort.signal.aborted) continue;
      this.#active++;
      this.#activeByWorkflow.set(
        execution.run.workflowId,
        (this.#activeByWorkflow.get(execution.run.workflowId) ?? 0) + 1,
      );
      execution.active = true;
      // 生命周期由明确终态释放，不能把一次工具调用返回视为子 Agent 已结束。
      execution.starting = this.#start(execution)
        .catch(async (cause) => {
          if (execution.abort.signal.aborted || execution.released) return;
          execution.run.status = cause instanceof NeedsUserError ? "blocked" : "failed";
          execution.run.error =
            cause instanceof NeedsUserError
              ? cause.message
              : "子 Agent 启动失败，请检查 CLI、批准或仓库";
          try {
            await this.#save(execution);
          } finally {
            await this.#release(execution);
          }
        })
        .catch(() => {});
    }
  }
  async #start(execution: Execution): Promise<void> {
    const { run, abort } = execution;
    const snapshot = (await this.host.list(execution.snapshot.plan.sessionId, abort.signal)).find(
      (snapshot) => snapshot.plan.workflowId === run.workflowId,
    );
    if (!snapshot || snapshot.plan.version !== run.planVersion) throw new Error("计划已变更");
    execution.snapshot = snapshot;
    const item = snapshot.plan.workItems.find((item) => item.workItemId === run.workItemId)!;
    await this.host.authorize(
      run.workflowId,
      run.planVersion,
      snapshot.digest,
      run.workItemId,
      abort.signal,
    );
    const dependencies = item.dependencies.map((id) =>
      snapshot.runs
        .filter((run) => run.intentVersion === snapshot.plan.intentVersion && run.workItemId === id)
        .at(-1)!,
    );
    if (dependencies.some((run) => !run || run.status !== "completed" || !run.revision))
      throw new NeedsUserError("依赖未完成或缺少具体成果版本");
    const revisions = dependencies
      .map((run) => run.revision)
      .filter((value): value is string => !!value);
    const integration = isIntegrationWorkItem(item);
    if (revisions.length > 1 && new Set(revisions).size > 1 && !integration) {
      throw new NeedsUserError("多个依赖成果需先安排独立整合工作项");
    }
    // 创建 worktree 也是副作用；先记回执，崩溃后不能重新创建空现场掩盖成果。
    await this.host.request(
      "run.phase",
      { runId: run.runId, phase: "start_requested" },
      abort.signal,
    );
    const workspace = await this.workspaces.create(
      snapshot.plan,
      run.runId,
      execution.resume?.revision ?? (integration ? undefined : revisions[0]),
    );
    abort.signal.throwIfAborted();
    Object.assign(run, {
      workspace: workspace.path,
      branch: workspace.branch,
      baselineCommit: workspace.baselineCommit,
    });
    run.status = "running";
    await this.#save(execution);
    if (integration) {
      if (!snapshot.plan.authorizedActions.includes("integrate")) throw new Error("计划未授权整合");
      const integrated = await this.workspaces.integrate(workspace.path, revisions);
      execution.integrationCommits = revisions;
      run.revision = integrated.revision;
      if (integrated.conflict)
        await this.host.request(
          "event",
          {
            workflowId: run.workflowId,
            kind: "integration.conflict",
            summary: "整合冲突已保留，当前整合执行者负责处理；未标记验收通过",
          },
          abort.signal,
        );
    }
    run.status = "running";
    await this.#save(execution);
    abort.signal.throwIfAborted();
    const provider = this.factory(run.provider);
    execution.provider = provider;
    execution.lastActivityAt = Date.now();
    // 健康检查只产生一次无活动提示，不轮询模型、不取消或重启可能仍在工作的进程。
    execution.healthTimer = setInterval(
      () => {
        if (
          execution.released ||
          abort.signal.aborted ||
          run.permission ||
          execution.stalled ||
          Date.now() - execution.lastActivityAt! < this.healthTimeoutMs
        )
          return;
        execution.stalled = true;
        execution.events = execution.events
          .then(async () => {
            if (execution.released || abort.signal.aborted) return;
            await this.host.request(
              "event",
              {
                workflowId: run.workflowId,
                kind: "run.health",
                summary: `${run.workItemId} · 长时间无新事件，进程仍保留，请观察或人工核对，不代表失败`,
              },
              abort.signal,
            );
          })
          .catch(() => {});
      },
      Math.max(10, Math.min(30_000, this.healthTimeoutMs)),
    );
    execution.healthTimer.unref();
    abort.signal.throwIfAborted();
    provider.start({
      cwd: workspace.path,
      writing: isWritingWorkItem(item),
      sessionId: execution.resume?.sessionId,
      prompt: [
        `只执行已登记工作项：${item.title}\n${item.objective}`,
        `范围：${snapshot.plan.scope.join("；")}\n验收：${item.acceptance.join("；")}`,
        `产出：${item.outputs.join("；")}`,
        `能力：${item.capabilities.join(", ")}；证据要求：${JSON.stringify(item.evidence)}。不要提交、push、启动协作者或改变源仓库。`,
        execution.resume
          ? `这是续接会话的新执行尝试。以前路径不再可写；当前工作区仅为 ${workspace.path}，请先核对已有成果，不重复可能生效的操作。`
          : "",
        isWritingWorkItem(item)
          ? `只在当前隔离工作区修改；隔离要求为 ${item.isolation}。`
          : "只读调查/审查；允许沙箱内的只读文件检查命令，禁止写入、网络操作及提权执行。",
        `依赖结果：${dependencies.map((run) => `${run.workItemId}: ${run.summary ?? ""} (${run.revision ?? "无提交"})`).join("\n")}`,
        "完成时说明已做工作、验证证据及未解决问题；不要输出内部推理。",
      ].join("\n"),
      emit: (event) => {
        execution.lastActivityAt = Date.now();
        execution.stalled = false;
        execution.events = execution.events
          .then(() => this.#event(execution, event))
          .catch(async () => {
            if (execution.abort.signal.aborted || execution.released) return;
            execution.run.status = "unknown";
            execution.run.error = "执行或成果保存未确认，需核对工作区后继续";
            try {
              await this.#save(execution);
            } finally {
              await this.#release(execution);
            }
          });
      },
      permission: (request) => {
        // Provider 可以同时请求多个权限；串行处理，不能覆盖 UI 当前待确认项。
        const permission = execution.permissions.then(() => this.#permission(execution, request));
        execution.permissions = permission.then(
          () => {},
          () => {},
        );
        return permission;
      },
      decision: (request) => this.#decision(execution, request),
    });
  }

  async #decision(
    execution: Execution,
    request: ProviderDecision,
  ): Promise<Record<string, unknown> | null> {
    const { run, abort, snapshot } = execution;
    // Provider 的请求 ID 只在其进程内唯一，持久层必须附带执行尝试身份。
    const requestId = `decision_${createHash("sha256").update(`${run.runId}:${request.requestId}`).digest("hex")}`;
    const key = `${run.workflowId}:${run.runId}:${requestId}`;
    if (this.#decisions.has(key) || abort.signal.aborted) return null;
    let cancel: () => void = () => {};
    const answer = new Promise<Record<string, unknown> | null>((resolve) => {
      cancel = () => resolve(null);
      this.#decisions.set(key, resolve);
      abort.signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      await this.host.authorize(
        run.workflowId,
        run.planVersion,
        snapshot.digest,
        run.workItemId,
        abort.signal,
      );
      await this.host.request(
        "delegate.request",
        {
          workflowId: run.workflowId,
          runId: run.runId,
          requestId,
          kind: request.kind,
          input: json(request.input),
        },
        abort.signal,
      );
      // 请求注册使 Host 唤醒协调 Pi。这里只等事件回执，不轮询模型。
      return await answer;
    } catch {
      return null;
    } finally {
      this.#decisions.delete(key);
      abort.signal.removeEventListener("abort", cancel);
    }
  }

  async decideRequest(
    session: string,
    workflowId: string,
    runId: string,
    requestId: string,
    kind: string,
    decision: JsonValue,
    signal: AbortSignal,
  ) {
    await this.#ownedSnapshot(session, workflowId, signal);
    let snapshot: JsonValue;
    try {
      snapshot = await this.host.request(
        "delegate.decision",
        { workflowId, runId, requestId, kind, decision },
        signal,
      );
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !/transport unavailable|acknowledgement timed out/i.test(cause.message)
      )
        throw cause;
      // 回执丢失只读回已保存决定，不再次执行 Provider 动作。
      const saved = await this.host.request("delegate.result", { workflowId, requestId }, signal);
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        saved.runId !== runId ||
        saved.kind !== kind ||
        JSON.stringify(saved.value) !== JSON.stringify(decision)
      )
        throw cause;
      snapshot = json(await this.#ownedSnapshot(session, workflowId, signal));
    }
    await this.resolveDecision(workflowId, requestId, signal);
    return snapshot;
  }

  /** 原生真人回答和代理决定都只从持久回执续接。转交用户时保持 Provider 等待。 */
  async resolveDecision(workflowId: string, requestId: string, signal: AbortSignal): Promise<void> {
    // 这里只重试读取回执；Provider 回调由 Promise 单次续接，不重放原工具。
    let saved: JsonValue = null;
    const delays = [2_000, 10_000, 30_000];
    for (let attempt = 0; ; attempt++) {
      try {
        saved = await this.host.request("delegate.result", { workflowId, requestId }, signal);
        break;
      } catch (cause) {
        if (
          signal.aborted ||
          attempt >= delays.length ||
          !(cause instanceof Error) ||
          !/transport unavailable|acknowledgement timed out/i.test(cause.message)
        )
          throw cause;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error("Decision lookup cancelled"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, delays[attempt]);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      }
    }
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      typeof saved.runId !== "string" ||
      !saved.value ||
      typeof saved.value !== "object" ||
      Array.isArray(saved.value)
    )
      return;
    if (saved.actor !== "user" && saved.value.authority !== "implementation_detail") return;
    this.#decisions.get(`${workflowId}:${saved.runId}:${requestId}`)?.(
      saved.value as Record<string, unknown>,
    );
  }
  async #permission(execution: Execution, request: ProviderPermission): Promise<boolean> {
    const { run, snapshot, abort } = execution;
    if (abort.signal.aborted) return false;
    try {
      await this.host.authorize(
        run.workflowId,
        run.planVersion,
        snapshot.digest,
        run.workItemId,
        abort.signal,
      );
      const item = snapshot.plan.workItems.find((item) => item.workItemId === run.workItemId)!;
      const decision = await this.host.request(
        "operation.authorize",
        {
          workflowId: run.workflowId,
          runId: run.runId,
          tool: request.tool,
          input: json(request.input),
        },
        abort.signal,
      );
      if (
        !decision ||
        typeof decision !== "object" ||
        Array.isArray(decision) ||
        typeof decision.delegated !== "boolean" ||
        !["read", "local_write", "external_side_effect"].includes(String(decision.risk))
      )
        return false;
      if (decision.delegated) {
        await this.host.authorize(
          run.workflowId,
          run.planVersion,
          snapshot.digest,
          run.workItemId,
          abort.signal,
        );
        return !abort.signal.aborted;
      }
      const read = decision.risk === "read";
      const write = ["write", "Write", "edit", "Edit", "file_change"].includes(request.tool);
      if (!read && !isWritingWorkItem(item)) return false;
      run.permission = {
        requestId: request.requestId,
        tool: request.tool,
        description: `${request.tool} · 等待 Host 授权`,
      };
      await this.#save(execution);
      if (read || (write && request.tool !== "file_change")) {
        const path = request.input.path ?? request.input.file_path ?? run.workspace;
        if (typeof path !== "string") return false;
        const target = resolve(run.workspace!, path);
        // 新文件可能位于尚不存在的嵌套目录；逐级找已有父路径，防止 symlink 越界。
        let actual = target;
        while (true) {
          try {
            actual = await realpath(actual);
            break;
          } catch {
            const parent = dirname(actual);
            if (parent === actual) return false;
            actual = parent;
          }
        }
        const distance = relative(await realpath(run.workspace!), actual);
        if (distance === ".." || distance.startsWith("../") || distance.startsWith("/"))
          return false;
      }
      const inputJson = JSON.stringify({
        runId: run.runId,
        workflowId: run.workflowId,
        tool: request.tool,
        input: request.input,
      });
      await this.policy.authorize(
        {
          taskId: run.runId,
          toolName: read ? "coding_read" : "coding_operation",
          riskLevel: read ? "read" : "external_side_effect",
          approvalId: `approval_${randomUUID().replaceAll("-", "")}`,
          inputDigest: `sha256:${createHash("sha256").update(inputJson).digest("hex")}`,
          inputJson,
        },
        abort.signal,
      );
      await this.host.authorize(
        run.workflowId,
        run.planVersion,
        snapshot.digest,
        run.workItemId,
        abort.signal,
      );
      return !abort.signal.aborted;
    } catch {
      return false;
    } finally {
      delete run.permission;
      if (!execution.released && !abort.signal.aborted) await this.#save(execution).catch(() => {});
    }
  }

  async #event(execution: Execution, event: ProviderEvent): Promise<void> {
    if (
      execution.abort.signal.aborted ||
      ["completed", "failed", "cancelled"].includes(execution.run.status)
    )
      return;
    const { run } = execution;
    if (event.kind === "session") {
      run.providerSessionId = event.sessionId;
      await this.host.request(
        "run.phase",
        { runId: run.runId, phase: "executing" },
        execution.abort.signal,
      );
      await this.#save(execution);
    }
    if (event.kind === "activity")
      await this.host.request(
        "event",
        {
          workflowId: run.workflowId,
          kind: "run.activity",
          summary: `${run.workItemId} · ${event.tool}`,
        },
        execution.abort.signal,
      );
    if (event.kind === "completed" || event.kind === "failed") {
      await execution.permissions;
      if (execution.abort.signal.aborted || execution.released) return;
      if (event.kind === "completed") {
        run.summary = event.summary;
        if (run.workspace) {
          // 本地提交也需重新授权；用户暂停/改意图之后不能自动提交迟到成果。
          await this.host.authorize(
            run.workflowId,
            run.planVersion,
            execution.snapshot.digest,
            run.workItemId,
            execution.abort.signal,
          );
          const item = execution.snapshot.plan.workItems.find(
            (item) => item.workItemId === run.workItemId,
          )!;
          if (
            isWritingWorkItem(item) &&
            execution.snapshot.plan.authorizedActions.includes("local_commit") &&
            hasCapability(item, "git:commit:local")
          ) {
            run.revision = await this.workspaces.deliver(
              run.workspace,
              `feat(workflow): deliver ${run.workItemId}`,
            );
            if (execution.integrationCommits) {
              const remaining = await this.workspaces.integrate(
                run.workspace,
                execution.integrationCommits,
              );
              run.revision = remaining.revision;
              if (remaining.conflict)
                throw new NeedsUserError("后续整合仍有冲突，工作区保留，需继续处理");
            }
          } else if (isWritingWorkItem(item)) {
            throw new NeedsUserError("工作项未授权本地提交，成果工作区已保留，需重新批准");
          } else if (!isWritingWorkItem(item)) {
            const revision = await this.workspaces.revision(run.workspace);
            if (revision !== run.baselineCommit)
              throw new NeedsUserError("只读工作区发生变化，不能作为审查证据");
            run.revision = revision;
          }
        }
      } else run.error = event.message;
      execution.abort.signal.throwIfAborted();
      run.status = event.kind === "completed" ? "completed" : "failed";
      run.endedAtMs = Date.now();
      await this.#save(execution);
      await this.host.request(
        "run.phase",
        { runId: run.runId, phase: "saved" },
        execution.abort.signal,
      );
      await this.#release(execution);
    }
  }
  async #save(execution: Execution): Promise<void> {
    parseWorkflowSnapshot(
      await this.host.request(
        "run",
        json(parseAgentRun(execution.run)),
        new AbortController().signal,
      ),
    );
  }
  async #release(execution: Execution): Promise<void> {
    if (execution.released) return;
    execution.released = true;
    if (execution.healthTimer) clearInterval(execution.healthTimer);
    try {
      await execution.provider?.stop();
    } finally {
      this.#executions.delete(execution.run.runId);
      if (execution.active) {
        this.#active--;
        const activeForWorkflow = (this.#activeByWorkflow.get(execution.run.workflowId) ?? 0) - 1;
        if (activeForWorkflow <= 0) this.#activeByWorkflow.delete(execution.run.workflowId);
        else this.#activeByWorkflow.set(execution.run.workflowId, activeForWorkflow);
        execution.active = false;
      }
      this.#drain();
    }
  }
  async stopWorkflow(workflowId: string): Promise<void> {
    const targets = [...this.#executions.values()].filter(
      (execution) => execution.run.workflowId === workflowId,
    );
    // 先同步撤销全部门控，再逐个等待关闭；释放第一名额时不得启动同工作流的队列。
    for (const execution of targets) {
      execution.abort.abort();
      const queued = this.#queue.indexOf(execution);
      if (queued >= 0) this.#queue.splice(queued, 1);
    }
    for (const execution of targets) {
      await execution.provider?.stop();
      // 创建 worktree 不可半途删除；等待启动边界结束后保留工作区，再记录取消。
      await execution.starting;
      await execution.events;
      if (!["completed", "failed", "cancelled"].includes(execution.run.status)) {
        execution.run.status = "cancelled";
        execution.run.endedAtMs = Date.now();
        await this.#save(execution);
      }
      await this.#release(execution);
    }
    this.#drain();
  }
  async steer(runId: string, text: string): Promise<void> {
    const execution = this.#executions.get(runId);
    if (!execution?.provider || execution.abort.signal.aborted)
      throw new Error("没有正在运行的子 Agent");
    if (!execution.provider.capabilities.steer)
      throw new Error("该 Provider 不支持运行中追加指令，请先停止后续接");
    await this.host.authorize(
      execution.run.workflowId,
      execution.run.planVersion,
      execution.snapshot.digest,
      execution.run.workItemId,
      execution.abort.signal,
    );
    execution.provider.steer(text);
    await this.host.request(
      "event",
      {
        workflowId: execution.run.workflowId,
        kind: "run.steered",
        summary: `${execution.run.workItemId} · 已追加范围内指令：${text.slice(0, 2000)}`,
      },
      execution.abort.signal,
    );
  }
  /** 用户答复先持久化交给主 Pi 判断；不能以答复代替批准或自动重启 unknown 操作。 */
  async userInstruction(
    session: string,
    workflowId: string,
    runId: string,
    text: string,
    answer: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
    const run = snapshot.runs.find(
      (run) => run.runId === runId && run.intentVersion === snapshot.plan.intentVersion,
    );
    if (!run || !text.trim() || text.length > 8000) throw new Error("无效执行指令");
    if (!answer) {
      await this.steer(runId, text);
      return;
    }
    if (!["blocked", "unknown"].includes(run.status)) throw new Error("该执行不处于待处理状态");
    await this.host.request(
      "event",
      { workflowId, kind: "user.answer", summary: `${run.workItemId} · 用户答复：${text.trim()}` },
      signal,
    );
  }
  async test(
    session: string,
    workflowId: string,
    runId: string,
    command: string,
    signal: AbortSignal,
  ) {
    const snapshot = (await this.host.list(session, signal)).find(
      (item) => item.plan.workflowId === workflowId,
    );
    const run = snapshot?.runs.find(
      (run) =>
        run.runId === runId &&
        run.intentVersion === snapshot.plan.intentVersion &&
        run.status === "completed",
    );
    if (
      !snapshot ||
      !run?.workspace ||
      !run.revision ||
      !snapshot.plan.workItems.some(
        (item) => item.workItemId === run.workItemId && isIntegrationWorkItem(item),
      )
    )
      throw new Error("测试需使用当前已交付的整合工作区");
    await this.host.authorize(
      workflowId,
      snapshot.plan.version,
      snapshot.digest,
      run.workItemId,
      signal,
    );
    await this.workspaces.restore(snapshot.plan, run);
    if ((await this.workspaces.revision(run.workspace)) !== run.revision)
      throw new Error("成果版本已改变，需重新交付");
    const inputJson = JSON.stringify({
      runId,
      workflowId,
      command,
      cwd: run.workspace,
      revision: run.revision,
    });
    const authorization = await this.host.request(
      "operation.authorize",
      {
        workflowId,
        runId,
        tool: "workspace_test",
        input: { command, revision: run.revision, confinement: "macos-seatbelt-v1" },
      },
      signal,
    );
    const confined =
      !!authorization &&
      typeof authorization === "object" &&
      !Array.isArray(authorization) &&
      authorization.delegated === true;
    if (!confined)
      await this.policy.authorize(
        {
          taskId: runId,
          toolName: "coding_operation",
          riskLevel: "external_side_effect",
          approvalId: `approval_${randomUUID().replaceAll("-", "")}`,
          inputJson,
          inputDigest: `sha256:${createHash("sha256").update(inputJson).digest("hex")}`,
        },
        signal,
      );
    await this.host.authorize(
      workflowId,
      snapshot.plan.version,
      snapshot.digest,
      run.workItemId,
      signal,
    );
    const output = await runTest(run.workspace, command, signal, confined);
    if ((await this.workspaces.revision(run.workspace)) !== run.revision)
      throw new Error("测试修改了工作区，结果未计入版本证据");
    const evidence = {
      command,
      exitCode: output.exitCode,
      revision: run.revision,
      artifactId: `artifact_${randomUUID().replaceAll("-", "")}`,
    };
    await this.host.request("test", { workflowId, runId, evidence, text: output.text }, signal);
    return evidence;
  }
  async recordFinding(session: string, workflowId: string, value: unknown, signal: AbortSignal) {
    await this.#ownedSnapshot(session, workflowId, signal);
    return this.host.request(
      "finding",
      { workflowId, finding: json(parseReviewFinding(value)) },
      signal,
    );
  }
  async recordIntegration(
    session: string,
    workflowId: string,
    value: unknown,
    signal: AbortSignal,
  ) {
    const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
    const result: IntegrationResult = parseIntegrationResult(value);
    const run = snapshot.runs.find(
      (run) => run.workspace === result.workspace && run.revision === result.revision,
    );
    if (!run) throw new Error("整合结果不属于已保存尝试");
    await this.workspaces.restore(snapshot.plan, run);
    if ((await this.workspaces.revision(result.workspace)) !== result.revision)
      throw new Error("整合版本已改变，旧证据不可使用");
    return this.host.request("integration", { workflowId, result: json(result) }, signal);
  }
  async #ownedSnapshot(session: string, id: string, signal: AbortSignal) {
    const snapshot = (await this.host.list(session, signal)).find(
      (item) => item.plan.workflowId === id,
    );
    if (!snapshot) throw new Error("工作流不属于当前会话");
    return snapshot;
  }
  /** 准备只读预览；执行令牌仅来自 Host 的独立用户批准，不注册成 Agent 工具。 */
  async prepareApplication(session: string, workflowId: string, signal: AbortSignal) {
    const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
    const result = snapshot.integration;
    if (snapshot.status !== "approved" || result?.status !== "verified")
      throw new NeedsUserError("需要已验证的当前整合成果");
    const run = snapshot.runs.find(
      (run) =>
        run.intentVersion === snapshot.plan.intentVersion &&
        run.workspace === result.workspace &&
        run.revision === result.revision &&
        run.status === "completed",
    );
    if (
      !run ||
      snapshot.runs.some(
        (run) =>
          run.intentVersion === snapshot.plan.intentVersion &&
          ["queued", "running", "blocked", "unknown"].includes(run.status),
      )
    )
      throw new NeedsUserError("请先结束或核对所有执行尝试");
    await this.workspaces.restore(snapshot.plan, run);
    if (!this.workspaces.applicationTarget)
      throw new Error("application is not supported by the workspace service");
    const target = await this.workspaces.applicationTarget(result.workspace, result.revision);
    return parseWorkflowApplication({
      applicationId: `apply_${randomUUID().replaceAll("-", "")}`,
      workflowId,
      version: snapshot.plan.version,
      digest: snapshot.digest,
      repository: snapshot.plan.repository,
      workspace: result.workspace,
      revision: result.revision,
      ...target,
    });
  }
  async applyApplication(
    session: string,
    workflowId: string,
    applicationId: string,
    signal: AbortSignal,
  ) {
    if (this.#applying.has(workflowId)) throw new NeedsUserError("成果应用已在执行");
    this.#applying.add(workflowId);
    let started = false;
    try {
      const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
      const request = parseWorkflowApplication(
        await this.host.request("application.begin", { applicationId }, signal),
      );
      started = true;
      if (
        request.workflowId !== workflowId ||
        snapshot.plan.version !== request.version ||
        snapshot.digest !== request.digest
      )
        throw new Error("application ownership changed");
      const run = snapshot.runs.find(
        (run) => run.workspace === request.workspace && run.revision === request.revision,
      );
      if (!run || !this.workspaces.apply) throw new Error("missing owned integration");
      await this.workspaces.restore(snapshot.plan, run);
      await this.workspaces.apply(request);
      await this.host.request("application.finish", { applicationId, applied: true }, signal);
      return { applied: true, revision: request.revision };
    } catch (cause) {
      if (started)
        await this.host
          .request(
            "application.finish",
            { applicationId, applied: false },
            new AbortController().signal,
          )
          .catch(() => {});
      throw cause;
    } finally {
      this.#applying.delete(workflowId);
    }
  }
  async inspectRun(session: string, workflowId: string, runId: string, signal: AbortSignal) {
    const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
    const run = snapshot.runs.find((run) => run.runId === runId);
    if (!run) throw new Error("未知尝试");
    await this.workspaces.restore(snapshot.plan, run);
    // 核对只读，不把工作区存在或 Provider 留下的文字当作完成证据。
    const revision = await this.workspaces.revision(run.workspace!).catch(() => undefined);
    return {
      run,
      revision,
      clean: !!revision,
      diff: await this.workspaces.diff(run.workspace!),
      providerSessionId: run.providerSessionId,
    };
  }
  async reconcile(session: string, workflowId: string, runId: string, signal: AbortSignal) {
    const snapshot = await this.#ownedSnapshot(session, workflowId, signal);
    const run = snapshot.runs.find((run) => run.runId === runId);
    if (!run || !["unknown", "blocked"].includes(run.status))
      throw new Error("仅待核对或阻塞尝试可结束核对");
    if (this.#executions.has(runId)) {
      await this.stopWorkflow(workflowId);
      // 停止服务已经保存终态，不能再次改写同一尝试的不可变记录。
      return this.#ownedSnapshot(session, workflowId, signal);
    }
    if (run.workspace) await this.workspaces.restore(snapshot.plan, run);
    // 不确定执行仅标记停止；保留成果，不伪造 completed，也不自动恢复/重复操作。
    return this.host.request(
      "run",
      json({
        ...run,
        status: "cancelled",
        endedAtMs: Date.now(),
        permission: undefined,
        error: "用户确认停止此尝试，原工作区和 Provider 会话保留；后续从明确成果重新派单",
      }),
      signal,
    );
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    // 退出只释放从未启动的内存队列；持久排队记录留给启动对账，不改成 cancelled。
    for (const execution of this.#queue.splice(0)) {
      execution.abort.abort();
      this.#executions.delete(execution.run.runId);
    }
    for (const workflowId of new Set(
      [...this.#executions.values()].map((item) => item.run.workflowId),
    ))
      await this.stopWorkflow(workflowId);
  }
}
