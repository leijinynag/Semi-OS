import type { ToolRiskLevel, VerificationRecord } from "@semi-os/shared";
import type { ToolExecutionReceipt } from "./receipt.js";

export type JsonObject = Readonly<Record<string, unknown>>;

export interface ToolExecutionContext {
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  idempotencyKey: string;
  workspace?: string;
  signal: AbortSignal;
  startedAtMs: number;
}

export interface ToolExecutionResult {
  output: JsonObject;
  outputSummary: string;
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
  inputSchema: JsonObject;
  requiredCapabilities: readonly string[];
  supportedPlatforms?: readonly NodeJS.Platform[];
  execute(
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  verify(
    input: JsonObject,
    result: ToolExecutionResult,
    context: ToolExecutionContext,
  ): Promise<VerificationRecord>;
  reconcile?(
    context: ToolReconciliationContext,
  ): Promise<ToolReconciliationResult>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  inputSchema: JsonObject;
}

export function toToolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    inputSchema: tool.inputSchema,
  };
}
