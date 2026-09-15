import type {
  RequestId,
  TaskId,
  TaskRunId,
  TraceId,
} from "@semi-os/shared";

export const PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EnvelopeContext {
  taskId?: TaskId;
  taskRunId?: TaskRunId;
  traceId?: TraceId;
}

export interface RequestEnvelope<TPayload extends JsonValue = JsonValue>
  extends EnvelopeContext {
  direction: "request";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: RequestId;
  kind: string;
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

export function encodeJsonl(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}
