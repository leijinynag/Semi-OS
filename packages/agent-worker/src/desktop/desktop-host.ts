import type { Envelope, EventPayloads, RequestId, RequestPayloads } from "@semi-os/protocol";
import type { ToolExecutionContext } from "@semi-os/tool-sdk";
import { createHash } from "node:crypto";

export type DesktopAction = EventPayloads["desktop.request"]["action"];
export type DesktopResult = RequestPayloads["desktop.result"]["result"];

/** Host 是唯一执行者。超时只报告 unknown，绝不重发可能已经输入的动作。 */
export class DesktopHost {
  readonly #pending = new Map<string, (result: DesktopResult) => void>();
  readonly #emit: (envelope: Envelope) => void;

  constructor(emit: (envelope: Envelope) => void) {
    this.#emit = emit;
  }

  receive(payload: RequestPayloads["desktop.result"]): void {
    this.#pending.get(payload.operationId)?.(payload.result);
  }

  dispose(): void {
    for (const finish of this.#pending.values())
      finish({ status: "unknown", summary: "Worker 已停止，请核对桌面结果", leaseGeneration: 0 });
    this.#pending.clear();
  }

  async execute(
    action: DesktopAction,
    inputJson: string,
    context: ToolExecutionContext,
  ): Promise<DesktopResult> {
    context.signal.throwIfAborted();
    const operationId = `req_desktop_${context.attemptId}`;
    if (this.#pending.has(operationId)) throw new Error("desktop operation already in flight");
    return new Promise<DesktopResult>((resolve) => {
      let settled = false;
      const finish = (result: DesktopResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener("abort", cancel);
        this.#pending.delete(operationId);
        resolve(result);
      };
      const uncertain = (summary: string) =>
        finish({ status: "unknown", summary, leaseGeneration: 0 });
      const cancel = () => {
        if (settled) return;
        try {
          this.#emit({
            protocolVersion: 1,
            direction: "event",
            requestId: `${operationId}_cancel` as RequestId,
            kind: "desktop.cancelled",
            payload: { operationId, taskId: context.taskId },
          });
        } catch {
          // Host 同时通过真实输入监听/进程生命周期撤销租约，通信失败不可重放。
        }
        uncertain("桌面请求被中断，可能已执行；请重新观察，禁止自动重试");
      };
      const timer = setTimeout(cancel, 20_000);
      context.signal.addEventListener("abort", cancel, { once: true });
      this.#pending.set(operationId, finish);
      if (context.signal.aborted) {
        cancel();
        return;
      }
      try {
        this.#emit({
          protocolVersion: 1,
          direction: "event",
          requestId: operationId as RequestId,
          kind: "desktop.request",
          payload: {
            operationId,
            taskId: context.taskId,
            attemptId: context.attemptId,
            inputJson,
            inputDigest: `sha256:${createHash("sha256").update(inputJson).digest("hex")}`,
            ...(context.approval ? { approvalId: context.approval.approvalId } : {}),
            action,
          },
        });
      } catch {
        cancel();
      }
    });
  }
}
