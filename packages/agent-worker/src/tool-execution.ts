import { createHash } from "node:crypto";
import type { PolicyDecision, VerificationRecord } from "@semi-os/shared";
import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionReceipt,
  ToolExecutionResult,
} from "@semi-os/tool-sdk";

export interface ToolAttemptIdentity {
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  idempotencyKey: string;
}

export interface ExecuteProductToolInput {
  tool: ToolDefinition;
  input: JsonObject;
  identity: ToolAttemptIdentity;
  signal: AbortSignal;
  policyDecision: PolicyDecision;
  now: () => number;
  inputSummary?: string;
}

export interface ExecutedProductTool {
  result: ToolExecutionResult;
  receipt: ToolExecutionReceipt;
}

export class ToolExecutionError extends Error {
  readonly receipt: ToolExecutionReceipt;
  readonly cause: unknown;

  constructor(message: string, receipt: ToolExecutionReceipt, cause?: unknown) {
    super(message);
    this.name = "ToolExecutionError";
    this.receipt = receipt;
    this.cause = cause;
  }
}

export function digestToolInput(input: JsonObject): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorVerification(
  stage: "policy" | "execute" | "verify",
  error: unknown,
): VerificationRecord {
  return {
    status: stage === "verify" ? "inconclusive" : "not_run",
    method: `semi_os_${stage}`,
    summary: errorMessage(error),
    evidence: [],
  };
}

function terminalReceipt(
  input: ExecuteProductToolInput,
  context: ToolExecutionContext,
  finishedAtMs: number,
  fields: Pick<
    ToolExecutionReceipt,
    "status" | "resultType" | "outputSummary" | "verification"
  >,
): ToolExecutionReceipt {
  return {
    ...input.identity,
    toolName: input.tool.name,
    status: fields.status,
    riskLevel: input.tool.riskLevel,
    inputSummary: input.inputSummary ?? `input for ${input.tool.name}`,
    inputDigest: digestToolInput(input.input),
    policyDecision: input.policyDecision,
    startedAtMs: context.startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - context.startedAtMs,
    resultType: fields.resultType,
    outputSummary: fields.outputSummary,
    verification: fields.verification,
    artifacts: [],
  };
}

/**
 * 执行一个 Semi-OS 自定义工具并生成唯一、完整的终态回执。
 *
 * 工具一旦进入 `execute`，写操作可能已经生效，因此异常不能伪装成确定失败；
 * 读操作可安全归为 failed，写和外部副作用归为 unknown，交给后续对账处理。
 */
export async function executeProductTool(
  input: ExecuteProductToolInput,
): Promise<ExecutedProductTool> {
  const context: ToolExecutionContext = {
    ...input.identity,
    signal: input.signal,
    startedAtMs: input.now(),
  };

  if (
    input.policyDecision !== "auto" &&
    input.policyDecision !== "approved"
  ) {
    const needsUser = input.policyDecision === "confirmation_required";
    const message = `tool execution is not authorized: ${input.tool.name} (${input.policyDecision})`;
    const receipt = terminalReceipt(input, context, input.now(), {
      status: needsUser ? "needs_user" : "failed",
      resultType: needsUser ? "needs_user" : "failure",
      outputSummary: message,
      verification: errorVerification("policy", message),
    });
    throw new ToolExecutionError(message, receipt);
  }

  let result: ToolExecutionResult;
  try {
    result = await input.tool.execute(input.input, context);
  } catch (error) {
    const uncertain = input.tool.riskLevel !== "read";
    const receipt = terminalReceipt(input, context, input.now(), {
      status: uncertain ? "unknown" : "failed",
      resultType: uncertain ? "unknown" : "failure",
      outputSummary: errorMessage(error),
      verification: errorVerification("execute", error),
    });
    throw new ToolExecutionError(errorMessage(error), receipt, error);
  }

  try {
    const verification = await input.tool.verify(input.input, result, context);
    const succeeded = verification.status === "passed";
    const receipt = {
      ...terminalReceipt(input, context, input.now(), {
        status: succeeded ? "succeeded" : "unknown",
        resultType: succeeded ? "success" : "unknown",
        outputSummary: result.outputSummary,
        verification,
      }),
      artifacts: result.artifacts ?? [],
    };
    return { result, receipt };
  } catch (error) {
    const receipt = {
      ...terminalReceipt(input, context, input.now(), {
        status: "unknown",
        resultType: "unknown",
        outputSummary: result.outputSummary,
        verification: errorVerification("verify", error),
      }),
      artifacts: result.artifacts ?? [],
    };
    throw new ToolExecutionError(errorMessage(error), receipt, error);
  }
}
