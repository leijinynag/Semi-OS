import { randomUUID } from "node:crypto";
import {
  parseWorkflowPlan,
  parseWorkflowSnapshot,
  type Envelope,
  type JsonValue,
  type RequestId,
  type WorkflowSnapshot,
} from "@semi-os/protocol";

/** 协作只经 Host 请求读写。此接口没有 decide，Agent 无法自批准实施计划。 */
export class WorkflowHost {
  readonly #emit: (event: Envelope) => void;
  readonly #pending = new Map<
    string,
    { resolve(value: JsonValue): void; reject(error: Error): void }
  >();
  constructor(emit: (event: Envelope) => void) {
    this.#emit = emit;
  }

  async submit(plan: unknown, signal: AbortSignal): Promise<WorkflowSnapshot> {
    const normalized = parseWorkflowPlan(plan);
    return parseSnapshot(
      await this.request("submit", JSON.parse(JSON.stringify(normalized)), signal),
    );
  }
  async list(sessionId: string, signal: AbortSignal): Promise<WorkflowSnapshot[]> {
    const value = await this.request("list", { sessionId }, signal);
    if (!Array.isArray(value)) throw new Error("invalid workflow list");
    return value.map(parseSnapshot);
  }
  async refine(plan: unknown, signal: AbortSignal): Promise<WorkflowSnapshot> {
    return parseSnapshot(
      await this.request("refine", JSON.parse(JSON.stringify(parseWorkflowPlan(plan))), signal),
    );
  }
  async authorize(
    workflowId: string,
    version: number,
    digest: string,
    workItemId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request("authorize", { workflowId, version, digest, workItemId }, signal);
  }
  request(
    operation: string,
    value: JsonValue,
    signal: AbortSignal,
    requestId?: RequestId,
  ): Promise<JsonValue> {
    signal.throwIfAborted();
    // 有限通信重试必须复用首次请求身份；不同请求不能共享同一个待处理回调。
    const operationId = requestId ?? `req_workflow_${randomUUID().replaceAll("-", "")}`;
    if (this.#pending.has(operationId)) throw new Error("Workflow request is already pending");
    return new Promise((resolve, reject) => {
      const cancel = () =>
        this.#pending.get(operationId)?.reject(new Error("Workflow request cancelled"));
      const timer = setTimeout(
        () =>
          this.#pending
            .get(operationId)
            ?.reject(new Error("Host workflow acknowledgement timed out")),
        10_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.#pending.delete(operationId);
      };
      this.#pending.set(operationId, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.#emit({
          direction: "event",
          protocolVersion: 1,
          requestId: operationId as RequestId,
          kind: "workflow.request",
          payload: { operationId, operation, value },
        });
      } catch {
        this.#pending.get(operationId)?.reject(new Error("Workflow transport unavailable"));
      }
    });
  }
  acknowledge(value: JsonValue): void {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.operationId !== "string" ||
      typeof value.ok !== "boolean"
    )
      throw new Error("invalid workflow acknowledgement");
    const pending = this.#pending.get(value.operationId);
    if (!pending) return;
    if (value.ok) pending.resolve(value.value ?? null);
    else
      pending.reject(
        new Error(typeof value.error === "string" ? value.error : "Host rejected workflow request"),
      );
  }
  dispose(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error("Worker disposed"));
  }
}

export const parseSnapshot = parseWorkflowSnapshot;
