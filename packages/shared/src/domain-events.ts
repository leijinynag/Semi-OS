import type {
  PolicyDecision,
  ResultType,
  TaskId,
  TaskLifecycle,
  TaskRunId,
  ToolAttemptStatus,
  TraceId,
  VerificationStatus,
  VoiceState,
  WorkerState,
} from "./generated/domain.generated.js";

export interface DomainEventContext {
  eventId: string;
  taskId: TaskId;
  taskRunId: TaskRunId;
  traceId: TraceId;
  occurredAtMs: number;
}

export interface VerificationRecord {
  status: VerificationStatus;
  method: string;
  summary: string;
  evidence: readonly {
    kind: string;
    reference: string;
  }[];
  verifiedAtMs?: number;
}

/**
 * Rust、Node 和 React 共同消费的领域事件。
 *
 * `kind` 是稳定判别字段，UI 必须依赖它和结构化字段渲染状态，不能从
 * assistant 文本中猜测执行结果。增加事件时需要同步 Rust 类型和契约 Fixture。
 */
export type DomainEvent = DomainEventContext &
  (
    | {
        kind: "task.lifecycle_changed";
        from?: TaskLifecycle;
        to: TaskLifecycle;
        reason?: string;
      }
    | {
        kind: "task.progress_updated";
        step: string;
        completedUnits?: number;
        totalUnits?: number;
      }
    | {
        kind: "voice.state_changed";
        state: VoiceState;
      }
    | {
        kind: "tool.attempt_updated";
        attemptId: string;
        toolName: string;
        status: ToolAttemptStatus;
        resultType?: ResultType;
      }
    | {
        kind: "approval.requested";
        approvalId: string;
        attemptId: string;
        action: string;
        payloadDigest: string;
      }
    | {
        kind: "approval.resolved";
        approvalId: string;
        attemptId: string;
        decision: PolicyDecision;
      }
    | {
        kind: "worker.state_changed";
        state: WorkerState;
        reason?: string;
      }
    | {
        kind: "verification.recorded";
        attemptId: string;
        verification: VerificationRecord;
      }
    | {
        kind: "task.result_recorded";
        resultType: ResultType;
        summary: string;
      }
  );

/**
 * 领域事件运行时验证错误。
 *
 * 由 `assertDomainEvent` 抛出，用于在 JSONL/IPC 边界捕获结构不合法的事件。
 * Rust Host 在事务提交前会做编解码校验，此错误仅用于 Node/React 边界。
 *
 * @example
 * ```ts
 * try {
 *   assertDomainEvent(event);
   } catch (error) {
     if (error instanceof DomainEventValidationError) {
       console.error('Invalid domain event:', error.message);
       // 可选：记录到 Sentry 或丢弃事件
     }
   }
 * ```
 */
export class DomainEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainEventValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainEventValidationError(`${field} must be a non-empty string`);
  }
}

/**
 * JSONL/IPC 边界上的领域事件运行时校验。
 *
 * 这里只验证路由和状态投影所依赖的稳定字段；事件专属的深层业务约束由
 * 对应 Host/Worker 模块负责，避免共享层复制工具实现规则。
 */
export function assertDomainEvent(
  value: unknown,
): asserts value is DomainEvent {
  if (!isRecord(value)) {
    throw new DomainEventValidationError("domain event must be an object");
  }
  assertNonEmptyString(value.eventId, "eventId");
  assertNonEmptyString(value.taskId, "taskId");
  assertNonEmptyString(value.taskRunId, "taskRunId");
  assertNonEmptyString(value.traceId, "traceId");
  if (
    typeof value.occurredAtMs !== "number" ||
    !Number.isSafeInteger(value.occurredAtMs)
  ) {
    throw new DomainEventValidationError(
      "occurredAtMs must be a safe integer",
    );
  }
  assertNonEmptyString(value.kind, "kind");

  switch (value.kind) {
    case "task.lifecycle_changed":
      assertNonEmptyString(value.to, "to");
      break;
    case "task.progress_updated":
      assertNonEmptyString(value.step, "step");
      break;
    case "voice.state_changed":
    case "worker.state_changed":
      assertNonEmptyString(value.state, "state");
      break;
    case "tool.attempt_updated":
      assertNonEmptyString(value.attemptId, "attemptId");
      assertNonEmptyString(value.toolName, "toolName");
      assertNonEmptyString(value.status, "status");
      break;
    case "approval.requested":
      assertNonEmptyString(value.approvalId, "approvalId");
      assertNonEmptyString(value.attemptId, "attemptId");
      assertNonEmptyString(value.action, "action");
      assertNonEmptyString(value.payloadDigest, "payloadDigest");
      break;
    case "approval.resolved":
      assertNonEmptyString(value.approvalId, "approvalId");
      assertNonEmptyString(value.attemptId, "attemptId");
      assertNonEmptyString(value.decision, "decision");
      break;
    case "verification.recorded":
      assertNonEmptyString(value.attemptId, "attemptId");
      if (!isRecord(value.verification)) {
        throw new DomainEventValidationError(
          "verification must be an object",
        );
      }
      break;
    case "task.result_recorded":
      assertNonEmptyString(value.resultType, "resultType");
      assertNonEmptyString(value.summary, "summary");
      break;
    default:
      throw new DomainEventValidationError(
        `unsupported domain event kind: ${value.kind}`,
      );
  }
}
