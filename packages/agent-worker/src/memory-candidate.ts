import { randomUUID } from "node:crypto";
import type { Envelope, EventPayloads, RequestId } from "@semi-os/protocol";

type SubmitPayload = EventPayloads["memory.candidate.submit"];

export type StructuredMemoryInput = {
  memoryId: string;
  scope?: SubmitPayload["scope"];
  sourceRef: string;
  origin: string;
  confidence?: number;
  importance?: number;
  conflictTarget?: SubmitPayload["conflictTarget"];
  operationId?: string;
} & (
  | { recordKind: "preference"; key: string; value: string }
  | { recordKind: "project_fact"; fact: string }
);

export type MemoryCandidateResultPayload = {
  operationId: string;
  memoryId?: string;
  status: "accepted" | "stored" | "duplicate" | "rejected";
  reason?: string | null;
  existingId?: string;
};

/** 将结构化轮次输入收成协议要求的 10 个字段，不调用模型。 */
export function buildStructuredMemoryCandidate(input: StructuredMemoryInput): SubmitPayload {
  const shared = {
    operationId: input.operationId,
    memoryId: input.memoryId,
    layer: "L2" as const,
    scope: input.scope ?? {},
    confidence: input.confidence ?? 90,
    importance: input.importance ?? 70,
    sourceRefs: [{ sourceRef: input.sourceRef, kind: "conversation_turn" as const }],
    conflictTarget: input.conflictTarget ?? null,
    origin: input.origin,
  };
  if (input.recordKind === "preference") {
    return {
      ...shared,
      recordKind: "preference",
      content: { kind: "preference", key: input.key, value: input.value },
    };
  }
  return {
    ...shared,
    recordKind: "project_fact",
    content: { kind: "project_fact", fact: input.fact },
  };
}

/** Worker 不持有 SQLite；提交后必须收到 Host 明确回执，超时不能假装写入成功。 */
export class MemoryCandidateHost {
  readonly #emit: (envelope: Envelope) => void;
  readonly #pending = new Map<
    string,
    {
      resolve: (result: MemoryCandidateResultPayload) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(emit: (envelope: Envelope) => void) {
    this.#emit = emit;
  }

  submit(candidate: SubmitPayload, signal: AbortSignal): Promise<MemoryCandidateResultPayload> {
    signal.throwIfAborted();
    const operationId = candidate.operationId ?? `req_memory_${randomUUID().replaceAll("-", "")}`;
    const payload: SubmitPayload = { ...candidate, operationId };
    return new Promise<MemoryCandidateResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending
          .get(operationId)
          ?.reject(new Error("Host memory candidate acknowledgement timed out"));
      }, 10_000);
      const cancel = () =>
        this.#pending.get(operationId)?.reject(new Error("Memory candidate submission cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.#pending.delete(operationId);
      };
      this.#pending.set(operationId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.#emit({
        direction: "event",
        protocolVersion: 1,
        requestId: operationId as RequestId,
        kind: "memory.candidate.submit",
        payload,
      });
    }).finally(() => this.#pending.delete(operationId));
  }

  receiveResult(payload: MemoryCandidateResultPayload): void {
    if (!payload || typeof payload !== "object" || typeof payload.operationId !== "string") {
      throw new Error("invalid memory candidate result");
    }
    if (!["accepted", "stored", "duplicate", "rejected"].includes(payload.status)) {
      throw new Error("invalid memory candidate result");
    }
    const pending = this.#pending.get(payload.operationId);
    if (!pending) return;
    if (payload.status === "rejected") {
      pending.reject(
        new Error(
          typeof payload.reason === "string" && payload.reason
            ? payload.reason
            : "Host rejected memory candidate",
        ),
      );
      return;
    }
    pending.resolve(payload);
  }

  dispose(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error("Worker disposed"));
    this.#pending.clear();
  }
}
