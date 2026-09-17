import type {
  PolicyDecision,
  ResultType,
  ToolAttemptStatus,
  ToolRiskLevel,
  VerificationRecord,
} from "@semi-os/shared";

export interface ToolTarget {
  kind: string;
  displayName: string;
  canonicalReference?: string;
}

export interface ApprovalBinding {
  approvalId: string;
  payloadDigest: string;
  approvedAtMs: number;
}

export interface ArtifactReference {
  artifactId: string;
  kind: string;
  uri: string;
  digest?: string;
}

/**
 * 工具执行的审计回执。
 *
 * `inputSummary` 必须脱敏，`inputDigest` 用于绑定实际规范化输入。成功状态
 * 仍必须由 `verification.status === "passed"` 支撑，不能只相信工具返回文本。
 */
export interface ToolExecutionReceipt {
  attemptId: string;
  taskId: string;
  toolName: string;
  idempotencyKey: string;
  attemptNumber: number;
  status: ToolAttemptStatus;
  riskLevel: ToolRiskLevel;
  inputSummary: string;
  inputDigest: string;
  target?: ToolTarget;
  policyDecision: PolicyDecision;
  approval?: ApprovalBinding;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  resultType?: ResultType;
  outputSummary?: string;
  verification?: VerificationRecord;
  artifacts: readonly ArtifactReference[];
}

/**
 * 检查工具执行是否为已验证的成功。
 *
 * 成功必须同时满足：状态为 succeeded、结果类型为 success、验证状态为 passed。
 */
export function isVerifiedSuccess(receipt: ToolExecutionReceipt): boolean {
  return (
    receipt.status === "succeeded" &&
    receipt.resultType === "success" &&
    receipt.verification?.status === "passed"
  );
}
