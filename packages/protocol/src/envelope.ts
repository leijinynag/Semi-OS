import type {
  RequestId,
  TaskId,
  TaskRunId,
  TraceId,
} from "@semi-os/shared";

/**
 * Host 与 Agent Worker 当前共同支持的协议版本。
 *
 * 协议版本不匹配时必须直接拒绝消息，不能尝试按“相近结构”继续执行，
 * 否则跨进程升级期间可能把字段含义解释错误。
 */
export const PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * 可选的任务追踪上下文。
 *
 * requestId 负责一次请求的关联，taskId/taskRunId/traceId 用于把该请求
 * 归入更长生命周期的任务、执行轮次和端到端调用链。
 */
export interface EnvelopeContext {
  /** 任务 ID，用于标识所属任务。 */
  taskId?: TaskId;
  /** 任务执行轮次 ID，用于标识所属执行轮次。 */
  taskRunId?: TaskRunId;
  /** 调用链 ID，用于端到端追踪。 */
  traceId?: TraceId;
}

export interface RequestEnvelope<TPayload extends JsonValue = JsonValue>
  extends EnvelopeContext {
  /** 请求方向标识。 */
  direction: "request";
  /** 协议版本。 */
  protocolVersion: typeof PROTOCOL_VERSION;
  /** 请求 ID，用于关联请求-响应。 */
  requestId: RequestId;
  /** 请求类型标识。 */
  kind: string;
  /** 请求载荷。 */
  payload: TPayload;
}

export interface ResponseEnvelope<TPayload extends JsonValue = JsonValue>
  extends EnvelopeContext {
  direction: "response";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: RequestId;
  kind: string;
  payload: TPayload;
}

export interface EventEnvelope<TPayload extends JsonValue = JsonValue>
  extends EnvelopeContext {
  direction: "event";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: RequestId;
  kind: string;
  payload: TPayload;
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export interface ErrorEnvelope extends EnvelopeContext {
  direction: "error";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: RequestId;
  kind: "protocol.error" | "request.error";
  payload: ErrorPayload;
}

export type Envelope =
  | RequestEnvelope
  | ResponseEnvelope
  | EventEnvelope
  | ErrorEnvelope;

// ID 前缀既用于人工排查日志，也用于避免不同领域 ID 被意外混用。
const idPatterns = {
  requestId: /^req_[A-Za-z0-9_-]+$/,
  taskId: /^task_[A-Za-z0-9_-]+$/,
  taskRunId: /^run_[A-Za-z0-9_-]+$/,
  traceId: /^trace_[A-Za-z0-9_-]+$/,
} as const;

export class ProtocolValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "ProtocolValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertId(
  value: unknown,
  field: keyof typeof idPatterns,
  required: boolean,
): void {
  if (value === undefined && !required) {
    return;
  }
  if (typeof value !== "string" || !idPatterns[field].test(value)) {
    throw new ProtocolValidationError(
      `${field} must match ${idPatterns[field].source}`,
      "invalid_field",
    );
  }
}

/**
 * 在进程边界执行最小且确定的运行时校验。
 *
 * TypeScript 类型会在编译后消失，因此来自 stdin、子进程或网络的数据
 * 必须先经过这里，才能收窄为 Envelope 并进入业务逻辑。
 */
export function assertValidEnvelope(value: unknown): asserts value is Envelope {
  if (!isRecord(value)) {
    throw new ProtocolValidationError(
      "Envelope must be a JSON object",
      "invalid_envelope",
    );
  }
  if (!("protocolVersion" in value)) {
    throw new ProtocolValidationError(
      "protocolVersion is required",
      "missing_field",
    );
  }
  if (!("direction" in value)) {
    throw new ProtocolValidationError("direction is required", "missing_field");
  }
  if (!("requestId" in value)) {
    throw new ProtocolValidationError("requestId is required", "missing_field");
  }
  if (!("kind" in value)) {
    throw new ProtocolValidationError("kind is required", "missing_field");
  }
  if (!("payload" in value)) {
    throw new ProtocolValidationError("payload is required", "missing_field");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      `Unsupported protocol version: ${String(value.protocolVersion)}`,
      "unsupported_version",
    );
  }
  if (
    value.direction !== "request" &&
    value.direction !== "response" &&
    value.direction !== "event" &&
    value.direction !== "error"
  ) {
    throw new ProtocolValidationError("direction is invalid", "invalid_field");
  }
  assertId(value.requestId, "requestId", true);
  assertId(value.taskId, "taskId", false);
  assertId(value.taskRunId, "taskRunId", false);
  assertId(value.traceId, "traceId", false);
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    throw new ProtocolValidationError(
      "kind must be a non-empty string",
      "invalid_field",
    );
  }
  if (value.direction === "error") {
    if (!isRecord(value.payload)) {
      throw new ProtocolValidationError(
        "error payload must be an object",
        "invalid_payload",
      );
    }
    if (
      typeof value.payload.code !== "string" ||
      value.payload.code.length === 0 ||
      typeof value.payload.message !== "string" ||
      typeof value.payload.retryable !== "boolean"
    ) {
      throw new ProtocolValidationError(
        "error payload shape is invalid",
        "invalid_payload",
      );
    }
    if (value.kind !== "protocol.error" && value.kind !== "request.error") {
      throw new ProtocolValidationError(
        "error kind is invalid",
        "invalid_field",
      );
    }
  }
}

/**
 * 每个信封编码为一条独立 JSONL 记录，尾部换行用于流式读取时定界。
 */
export function encodeJsonl(envelope: Envelope): string {
  assertValidEnvelope(envelope);
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * 解码单条 JSONL 记录。
 *
 * 这里只接受一条记录和至多一个尾随换行，避免调用方误把多条消息当成
 * 一个原子请求处理。流的分帧工作应由上层逐行读取器负责。
 */
export function decodeJsonl(line: string): Envelope {
  const normalizedLine = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (
    normalizedLine.length === 0 ||
    normalizedLine.includes("\n") ||
    normalizedLine.includes("\r")
  ) {
    throw new ProtocolValidationError(
      "JSONL input must contain exactly one line",
      "invalid_jsonl",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(normalizedLine) as unknown;
  } catch {
    throw new ProtocolValidationError(
      "JSONL input is not valid JSON",
      "invalid_json",
    );
  }
  assertValidEnvelope(value);
  return value;
}
