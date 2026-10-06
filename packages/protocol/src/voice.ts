import type { RequestId } from "@semi-os/shared";
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  type EventEnvelope,
  type JsonValue,
  type RequestEnvelope,
} from "./envelope.ts";

export const VOICE_REQUEST_KINDS = [
  "voice.turn.start",
  "voice.audio.append",
  "voice.turn.commit",
  "voice.interrupt",
] as const;

export const VOICE_EVENT_KINDS = [
  "voice.state",
  "voice.transcript.partial",
  "voice.transcript.final",
  "voice.assistant.text_delta",
  "voice.audio.chunk",
  "voice.audio.completed",
  "voice.audio.stop",
  "voice.turn.completed",
  "voice.error",
] as const;

export type VoiceRequestKind = (typeof VOICE_REQUEST_KINDS)[number];
export type VoiceEventKind = (typeof VOICE_EVENT_KINDS)[number];
export type VoiceTurnAction = "prompt" | "steer" | "follow_up";

export interface VoiceTurnStartPayload {
  sessionId: string;
  taskId: string;
  cwd: string;
  mimeType: string;
  sampleRateHz?: number;
  action?: VoiceTurnAction;
}

export interface VoiceAudioAppendPayload {
  sequence: number;
  audioBase64: string;
}

export interface VoiceTurnCommitPayload {
  lastSequence: number;
}

export interface VoiceInterruptPayload {
  taskId: string;
  mode: "pause" | "cancel" | "steer";
  text?: string;
}

export type VoiceRequestPayloadByKind = {
  "voice.turn.start": VoiceTurnStartPayload;
  "voice.audio.append": VoiceAudioAppendPayload;
  "voice.turn.commit": VoiceTurnCommitPayload;
  "voice.interrupt": VoiceInterruptPayload;
};

export type VoiceRequestEnvelope = {
  [K in VoiceRequestKind]: Omit<RequestEnvelope, "kind" | "payload"> & {
    kind: K;
    payload: VoiceRequestPayloadByKind[K];
  };
}[VoiceRequestKind];

export interface VoiceStatePayload {
  state:
    | "idle"
    | "listening"
    | "transcribing"
    | "thinking"
    | "speaking"
    | "interrupted"
    | "error";
}

export interface VoiceAudioChunkPayload {
  sentenceId: string;
  sequence: number;
  mimeType: string;
  audioBase64: string;
  first: boolean;
}

export type VoiceEventEnvelope = EventEnvelope & { kind: VoiceEventKind };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  field: string,
): string {
  const entry = value[field];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new ProtocolValidationError(
      `${field} must be a non-empty string`,
      "invalid_payload",
    );
  }
  return entry;
}

function requireInteger(
  value: Record<string, unknown>,
  field: string,
  minimum = 0,
): number {
  const entry = value[field];
  if (!Number.isSafeInteger(entry) || Number(entry) < minimum) {
    throw new ProtocolValidationError(
      `${field} must be an integer greater than or equal to ${minimum}`,
      "invalid_payload",
    );
  }
  return Number(entry);
}

/**
 * 校验 Host 发往 Worker 的语音请求。
 *
 * Envelope 只保证 JSONL 外壳有效；语音载荷还要在进入录音缓存、Provider 和
 * Agent Runtime 前再次校验。音频使用 base64 是 MVP 的有界折中，后续改成
 * 二进制 side channel 时不需要改变上层 VoiceLoop 的事件语义。
 */
export function parseVoiceRequest(
  envelope: RequestEnvelope,
): VoiceRequestEnvelope {
  if (!VOICE_REQUEST_KINDS.includes(envelope.kind as VoiceRequestKind)) {
    throw new ProtocolValidationError(
      `Unsupported voice request: ${envelope.kind}`,
      "unsupported_request",
    );
  }
  if (!isRecord(envelope.payload)) {
    throw new ProtocolValidationError(
      "voice payload must be an object",
      "invalid_payload",
    );
  }

  switch (envelope.kind as VoiceRequestKind) {
    case "voice.turn.start": {
      requireString(envelope.payload, "sessionId");
      requireString(envelope.payload, "taskId");
      requireString(envelope.payload, "cwd");
      requireString(envelope.payload, "mimeType");
      const action = envelope.payload.action;
      if (
        action !== undefined &&
        action !== "prompt" &&
        action !== "steer" &&
        action !== "follow_up"
      ) {
        throw new ProtocolValidationError(
          "action is invalid",
          "invalid_payload",
        );
      }
      break;
    }
    case "voice.audio.append":
      requireInteger(envelope.payload, "sequence");
      requireString(envelope.payload, "audioBase64");
      break;
    case "voice.turn.commit":
      // MediaRecorder 在极短按键下可能不产出分片。-1 明确表示空录音，
      // Worker 会把它交给 STT 的 silence 路径，而不是伪造一个音频字节。
      requireInteger(envelope.payload, "lastSequence", -1);
      break;
    case "voice.interrupt": {
      requireString(envelope.payload, "taskId");
      const mode = envelope.payload.mode;
      if (mode !== "pause" && mode !== "cancel" && mode !== "steer") {
        throw new ProtocolValidationError(
          "interrupt mode is invalid",
          "invalid_payload",
        );
      }
      if (
        envelope.payload.text !== undefined &&
        typeof envelope.payload.text !== "string"
      ) {
        throw new ProtocolValidationError(
          "interrupt text must be a string",
          "invalid_payload",
        );
      }
      break;
    }
  }
  return envelope as unknown as VoiceRequestEnvelope;
}

export function createVoiceEvent(
  requestId: RequestId,
  kind: VoiceEventKind,
  payload: JsonValue,
): VoiceEventEnvelope {
  return {
    direction: "event",
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    kind,
    payload,
  };
}
