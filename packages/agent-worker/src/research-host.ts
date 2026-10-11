import { randomUUID } from "node:crypto";
import type { ResearchSource, ResearchReport, Envelope, RequestId, JsonValue } from "@semi-os/protocol";
import type { ResearchSink } from "./browser/browser-tools.ts";
import type { BrowserPolicyEvidence } from "./browser/browser-service.ts";

export interface ResearchAuthorization {
  taskId: string;
  toolName: string;
  riskLevel: string;
  inputDigest: string;
  approvalId: string;
  inputJson: string;
  evidence?: BrowserPolicyEvidence;
}

/** Worker 不持有 SQLite；Host 确认持久化成功后才完成工具，超时不能伪造保存成功。 */
export class ResearchHost implements ResearchSink {
  readonly #emit: (envelope: Envelope) => void;
  readonly #pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  constructor(emit: (envelope: Envelope) => void) { this.#emit = emit; }
  authorize(value: ResearchAuthorization, signal: AbortSignal): Promise<void> {
    return this.#request("policy", value, signal);
  }
  save(source: ResearchSource, signal: AbortSignal): Promise<void> {
    return this.#request("source", source, signal);
  }
  report(report: ResearchReport, signal: AbortSignal): Promise<void> {
    return this.#request("report", report, signal);
  }
  acknowledge(payload: JsonValue): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid Host acknowledgement");
    const { operationId, ok, error } = payload;
    if (typeof operationId !== "string" || typeof ok !== "boolean") throw new Error("invalid Host acknowledgement");
    const pending = this.#pending.get(operationId);
    if (!pending) return;
    if (ok) pending.resolve(); else pending.reject(new Error(typeof error === "string" ? error : "Host rejected evidence"));
  }
  dispose(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error("Worker disposed"));
    this.#pending.clear();
  }
  async #request(operation: string, value: ResearchSource | ResearchReport | ResearchAuthorization, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const operationId = `req_evidence_${randomUUID().replaceAll("-", "")}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#pending.get(operationId)?.reject(new Error("Host persistence acknowledgement timed out")), operation === "policy" ? 120_000 : 10_000);
      const cancel = () => this.#pending.get(operationId)?.reject(new Error("Evidence operation cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); this.#pending.delete(operationId); };
      this.#pending.set(operationId, {
        resolve: () => { cleanup(); resolve(); },
        reject: (error) => {
          cleanup();
          if (operation === "policy") this.#emit({
            direction: "event", protocolVersion: 1, requestId: operationId as RequestId,
            kind: "research.policy.cancelled", payload: { operationId },
          });
          reject(error);
        },
      });
      this.#emit({
        direction: "event", protocolVersion: 1, requestId: operationId as RequestId,
        kind: "research.persist", payload: { operationId, operation, value: JSON.parse(JSON.stringify(value)) as JsonValue },
      });
    }).finally(() => this.#pending.delete(operationId));
  }
}
