import type { ToolRiskLevel, VerificationRecord } from "@semi-os/shared";
import type { ApprovalBinding, ToolExecutionReceipt } from "./receipt.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export type ToolObservationFreshness = "fresh" | "best_effort" | "none";
export interface ToolObservationContract {
  required: boolean;
  freshness: ToolObservationFreshness;
}

export type ToolMutationKind = "none" | "workspace" | "external";
export interface ToolMutationContract {
  kind: ToolMutationKind;
  atomic: boolean;
}

export type ToolVerificationMethod = "tool" | "host" | "artifact" | "none";
export interface ToolVerificationContract {
  required: boolean;
  method: ToolVerificationMethod;
}

export type ToolReversibility = "reversible" | "partially_reversible" | "irreversible";
export type ToolIdempotency = "idempotent" | "keyed" | "non_idempotent";
export type ToolReconciliation = "safe" | "required" | "unsupported";

/**
 * 工具契约描述的是执行语义，不是模型提示词。字段可选是为了兼容旧工具；
 * 进入 Registry 或执行器后必须通过 normalizeToolContract 得到完整判定。
 */
export interface ToolContract {
  observation?: ToolObservationContract;
  mutation?: ToolMutationContract;
  verification?: ToolVerificationContract;
  reversibility?: ToolReversibility;
  idempotency?: ToolIdempotency;
  reconciliation?: ToolReconciliation;
}

export interface ToolExecutionContext {
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  idempotencyKey: string;
  workspace?: string;
  signal: AbortSignal;
  startedAtMs: number;
  approval?: ApprovalBinding;
}

export interface ToolExecutionResult {
  output: JsonObject;
  outputSummary: string;
  resultType?: "needs_user" | "failure";
  artifacts?: ToolExecutionReceipt["artifacts"];
}

export interface ToolReconciliationContext {
  taskId: string;
  idempotencyKey: string;
  previousReceipt: ToolExecutionReceipt;
  signal: AbortSignal;
}

export interface ToolReconciliationResult {
  status: "succeeded" | "failed" | "needs_user";
  summary: string;
  verification: VerificationRecord;
}

/**
 * Semi-OS 自定义工具的稳定契约。
 *
 * Registry 保存的是产品领域描述，不暴露 Pi 的工具类型。这样工具实现可被
 * Fake Runtime、未来 MCP Gateway 或其他 Agent Runtime 复用。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  contract?: ToolContract;
  /** 基于可信目标观察解析风险；模型提供的 purpose 不能作为降级依据。 */
  resolveRisk?(input: JsonObject, signal?: AbortSignal): Promise<ToolRiskLevel>;
  inputSchema: JsonObject;
  requiredCapabilities: readonly string[];
  supportedPlatforms?: readonly NodeJS.Platform[];
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  verify(
    input: JsonObject,
    result: ToolExecutionResult,
    context: ToolExecutionContext,
  ): Promise<VerificationRecord>;
  reconcile?(context: ToolReconciliationContext): Promise<ToolReconciliationResult>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  inputSchema: JsonObject;
  contract: NormalizedToolContract;
}

export interface NormalizedToolContract {
  observation: ToolObservationContract;
  mutation: ToolMutationContract;
  verification: ToolVerificationContract;
  reversibility: ToolReversibility;
  idempotency: ToolIdempotency;
  reconciliation: ToolReconciliation;
}

export function normalizeToolContract(
  tool: Pick<ToolDefinition, "riskLevel" | "contract">,
): NormalizedToolContract {
  const risk = tool.riskLevel;
  const declared = tool.contract ?? {};
  const mutationKind: ToolMutationKind =
    risk === "read" ? "none" : risk === "local_write" ? "workspace" : "external";
  return {
    observation: declared.observation ?? {
      required: risk !== "read",
      freshness: "none",
    },
    mutation: declared.mutation ?? {
      kind: mutationKind,
      atomic: false,
    },
    verification: declared.verification ?? {
      required: risk !== "read",
      method: "none",
    },
    reversibility:
      declared.reversibility ??
      (risk === "read"
        ? "reversible"
        : risk === "local_write"
          ? "partially_reversible"
          : "irreversible"),
    idempotency:
      declared.idempotency ??
      (risk === "read" ? "idempotent" : risk === "local_write" ? "keyed" : "non_idempotent"),
    reconciliation: declared.reconciliation ?? (risk === "read" ? "safe" : "required"),
  };
}

export function toToolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    inputSchema: tool.inputSchema,
    contract: normalizeToolContract(tool),
  };
}
