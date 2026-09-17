// 由 scripts/generate-protocol.mjs 自动生成，请勿手动修改。
// 修改类型时请编辑 schemas/protocol.schema.json 后重新生成。

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TaskId = Brand<string, "TaskId">;
export type TaskRunId = Brand<string, "TaskRunId">;
export type TraceId = Brand<string, "TraceId">;
export type RequestId = Brand<string, "RequestId">;
export type TaskLifecycle = "created" | "listening" | "understanding" | "running" | "paused" | "waiting_confirmation" | "verifying" | "completed" | "failed" | "unknown" | "reconciling" | "needs_user" | "cancelled";

export type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "interrupted" | "error";

export type ToolRiskLevel = "read" | "local_write" | "external_side_effect" | "privileged";

export type ResultType = "success" | "failure" | "unknown" | "cancelled" | "needs_user";

export type ToolAttemptStatus = "started" | "succeeded" | "failed" | "unknown" | "cancelled" | "needs_user";

export type PolicyDecision = "auto" | "confirmation_required" | "approved" | "rejected";

export type VerificationStatus = "passed" | "failed" | "inconclusive" | "not_run";

export type WorkerState = "starting" | "ready" | "degraded" | "restarting" | "stopped";

export type CapabilityStatus = "available" | "degraded" | "unavailable" | "unknown";

