/** 展示协议只投影 Host 事实，不解释模型正文，也不维护第二套任务生命周期。 */
export type ExecutionStatus =
  "started" | "succeeded" | "failed" | "cancelled" | "unknown" | "needs_user";
export interface ExecutionReceipt {
  attemptId: string;
  taskId: string;
  toolName: string;
  idempotencyKey: string;
  status: ExecutionStatus;
  inputSummary: string;
  outputSummary?: string;
  durationMs?: number;
}
export interface ExecutionApproval {
  operationId: string;
  value: { taskId: string; toolName: string; inputJson: string; riskLevel: string };
}
export interface ExecutionSource {
  sourceId: string;
  taskId: string;
  title: string;
  finalUrl: string;
  status: "collected" | "needs_user" | "failed";
  reason?: string;
  artifactId?: string;
}
export interface ExecutionSnapshot {
  taskId: string;
  lifecycle: string | null;
  progress: Array<{ sequence: number; callId: string; toolName: string; label: string }>;
  receipts: ExecutionReceipt[];
  sources: ExecutionSource[];
  approvals: ExecutionApproval[];
}
export interface ExecutionAction {
  id: string;
  toolName: string;
  label: string;
  status: ExecutionStatus;
  receipt?: ExecutionReceipt;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("执行数据格式错误");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("执行数据缺少文字字段");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("执行数据缺少列表");
  return value;
}
export function parseApproval(value: unknown): ExecutionApproval {
  const item = record(value);
  const input = record(item.value);
  return {
    operationId: text(item.operationId),
    value: {
      taskId: text(input.taskId),
      toolName: text(input.toolName),
      inputJson: text(input.inputJson),
      riskLevel: text(input.riskLevel),
    },
  };
}
export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
const lifecycles = new Set([
  "created",
  "listening",
  "understanding",
  "running",
  "paused",
  "waiting_confirmation",
  "verifying",
  "completed",
  "failed",
  "unknown",
  "reconciling",
  "needs_user",
  "cancelled",
]);
const statuses = new Set(["started", "succeeded", "failed", "cancelled", "unknown", "needs_user"]);
export function parseExecution(value: unknown, taskId: string): ExecutionSnapshot {
  const item = record(value);
  if (
    item.taskId !== taskId ||
    !(item.lifecycle === null || lifecycles.has(String(item.lifecycle)))
  )
    throw new Error("执行任务身份或状态不匹配");
  const progress = list(item.progress).map((raw) => {
    const step = record(raw);
    if (!Number.isSafeInteger(step.sequence)) throw new Error("执行事件序号错误");
    return {
      sequence: step.sequence as number,
      callId: text(step.callId),
      toolName: text(step.toolName),
      label: text(step.label),
    };
  });
  const receipts = list(item.receipts).map((raw): ExecutionReceipt => {
    const receipt = record(raw);
    if (receipt.taskId !== taskId || !statuses.has(String(receipt.status)))
      throw new Error("工具回执身份或状态错误");
    if (
      receipt.durationMs != null &&
      (typeof receipt.durationMs !== "number" ||
        !Number.isFinite(receipt.durationMs) ||
        receipt.durationMs < 0)
    )
      throw new Error("工具耗时错误");
    return {
      attemptId: text(receipt.attemptId),
      taskId,
      toolName: text(receipt.toolName),
      idempotencyKey: text(receipt.idempotencyKey),
      status: receipt.status as ExecutionStatus,
      inputSummary: text(receipt.inputSummary),
      outputSummary: receipt.outputSummary == null ? undefined : text(receipt.outputSummary),
      durationMs: receipt.durationMs == null ? undefined : (receipt.durationMs as number),
    };
  });
  const sources = list(item.sources).map((raw): ExecutionSource => {
    const source = record(raw);
    if (!["collected", "needs_user", "failed"].includes(String(source.status)))
      throw new Error("来源状态错误");
    // Host 允许报告引用同会话旧轮次的来源，保留来源自己的 taskId。
    return {
      sourceId: text(source.sourceId),
      taskId: text(source.taskId),
      title: text(source.title),
      finalUrl: text(source.finalUrl),
      status: source.status as ExecutionSource["status"],
      reason: source.reason == null ? undefined : text(source.reason),
      artifactId: source.artifactId == null ? undefined : text(source.artifactId),
    };
  });
  const approvals = list(item.approvals).map(parseApproval);
  if (approvals.some((approval) => approval.value.taskId !== taskId))
    throw new Error("确认任务身份不匹配");
  return {
    taskId,
    lifecycle: item.lifecycle as string | null,
    progress,
    receipts,
    sources,
    approvals,
  };
}
export function executionIsActive(snapshot: ExecutionSnapshot): boolean {
  return (
    snapshot.lifecycle !== null &&
    [
      "created",
      "listening",
      "understanding",
      "running",
      "waiting_confirmation",
      "verifying",
      "reconciling",
    ].includes(snapshot.lifecycle)
  );
}
/** callId 与 attemptId 不同；只能用执行层生成的幂等键关联，不能按工具名猜测。 */
export function executionActions(snapshot: ExecutionSnapshot): ExecutionAction[] {
  const byAttempt = new Map(snapshot.receipts.map((receipt) => [receipt.attemptId, receipt]));
  const receipts = [...byAttempt.values()];
  const seen = new Set<string>();
  const steps = new Map(
    snapshot.progress
      .filter((step) => step.toolName !== "research_report")
      .sort((a, b) => a.sequence - b.sequence)
      .map((step) => [step.callId, step]),
  );
  const actions: ExecutionAction[] = [...steps.values()].map((step) => {
    const receipt = receipts.find(
      (item) => item.idempotencyKey === `${snapshot.taskId}:${step.callId}`,
    );
    if (receipt) seen.add(receipt.attemptId);
    const status = receipt?.status ?? "started";
    return {
      id: step.callId,
      label: step.label,
      toolName: step.toolName,
      receipt,
      status: status === "started" && !executionIsActive(snapshot) ? "unknown" : status,
    };
  });
  for (const receipt of receipts)
    if (!seen.has(receipt.attemptId))
      actions.push({
        id: receipt.attemptId,
        label: receipt.toolName,
        toolName: receipt.toolName,
        receipt,
        status:
          receipt.status === "started" && !executionIsActive(snapshot) ? "unknown" : receipt.status,
      });
  return actions;
}
export const executionStatusLabel: Record<ExecutionStatus, string> = {
  started: "执行中",
  succeeded: "已执行",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果待核对",
  needs_user: "需要处理",
};
