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
  "voice.text.submit",
  "voice.interrupt",
  "voice.session.dispose",
] as const;

export const VOICE_EVENT_KINDS = [
  "voice.state",
  "voice.transcript.partial",
  "voice.transcript.final",
  "voice.assistant.text_delta",
  "voice.answer",
  "voice.sentence",
  "voice.timestamps",
  "voice.audio.chunk",
  "voice.audio.completed",
  "voice.audio.stop",
  "voice.turn.completed",
  "voice.error",
  "research.progress",
  "research.receipt",
  "research.report",
  "research.timing",
  "research.interrupted",
] as const;

export type VoiceRequestKind = (typeof VOICE_REQUEST_KINDS)[number];
export type VoiceEventKind = (typeof VOICE_EVENT_KINDS)[number];
export type VoiceTurnAction = "prompt" | "steer" | "follow_up";
export const TEXT_INPUT_MAX_LENGTH = 64_000;

/** 文字输入仅替代最终转写，不携带音频，也不创建另一套 Agent Loop。 */
export interface VoiceTextSubmitPayload {
  sessionId: string;
  taskId: string;
  cwd: string;
  text: string;
  action?: VoiceTurnAction;
}

/** 固定 PCM 契约：有符号 16 位小端、单声道；禁止播放器猜测采样率。 */
export const VOICE_PCM_MIME = "audio/pcm;rate=22050;channels=1;format=s16le";

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
  "voice.text.submit": VoiceTextSubmitPayload;
  "voice.interrupt": VoiceInterruptPayload;
  "voice.session.dispose": { sessionId: string };
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

export interface VoiceWordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

/** requestId 标识轮次；载荷同时绑定会话和任务，防止跨窗口迟到事件串线。 */
export interface VoiceSentencePayload {
  sessionId: string;
  taskId: string;
  sentenceId: string;
  text: string;
  purpose: "answer" | "stage" | "confirmation";
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
    case "voice.session.dispose":
      requireString(envelope.payload, "sessionId");
      break;
    case "voice.text.submit":
    case "voice.turn.start": {
      requireString(envelope.payload, "sessionId");
      requireString(envelope.payload, "taskId");
      requireString(envelope.payload, "cwd");
      if (envelope.kind === "voice.text.submit") {
        const text = requireString(envelope.payload, "text");
        if (!text.trim() || text.length > TEXT_INPUT_MAX_LENGTH) {
          throw new ProtocolValidationError("text is empty or too long", "invalid_payload");
        }
      } else requireString(envelope.payload, "mimeType");
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

/** 播放前校验 Worker 边界，畸形元数据不能创建音频队列或进入文字报告。 */
export function parseVoiceEvent(envelope: EventEnvelope): VoiceEventEnvelope {
  if (!VOICE_EVENT_KINDS.includes(envelope.kind as VoiceEventKind) || !isRecord(envelope.payload)) {
    throw new ProtocolValidationError("invalid voice event", "invalid_payload");
  }
  const payload = envelope.payload;
  const boundedString = (field: string, maximum: number, empty = false) => {
    const value = payload[field];
    if (typeof value !== "string" || (!empty && !value) || value.length > maximum) {
      throw new ProtocolValidationError(`invalid ${field}`, "invalid_payload");
    }
  };
  if (["voice.sentence", "voice.timestamps", "voice.audio.chunk", "voice.audio.completed", "voice.answer"].includes(envelope.kind)) {
    boundedString("sessionId", 160);
    boundedString("taskId", 160);
  }
  if (["voice.sentence", "voice.timestamps", "voice.audio.chunk", "voice.audio.completed"].includes(envelope.kind)) boundedString("sentenceId", 160);
  switch (envelope.kind) {
    case "voice.sentence":
      boundedString("text", 8192);
      if (!["answer", "stage", "confirmation"].includes(String(payload.purpose))) throw new ProtocolValidationError("invalid sentence purpose", "invalid_payload");
      break;
    case "voice.timestamps":
      if (!Array.isArray(payload.words) || payload.words.length > 4096 || !payload.words.every((word) =>
        isRecord(word) && typeof word.text === "string" && word.text.length <= 8192 &&
        Number.isSafeInteger(word.startMs) && Number.isSafeInteger(word.endMs) &&
        Number(word.startMs) >= 0 && Number(word.endMs) >= Number(word.startMs) && Number(word.endMs) <= 600_000)) {
        throw new ProtocolValidationError("invalid word timestamps", "invalid_payload");
      }
      break;
    case "voice.answer":
      boundedString("summary", 128_000, true);
      boundedString("report", 512_000, true);
      break;
    case "voice.audio.chunk":
      boundedString("audioBase64", 2_000_000);
      requireInteger(payload, "sequence");
      if (!["audio/mpeg", VOICE_PCM_MIME].includes(String(payload.mimeType)) || typeof payload.first !== "boolean" ||
        String(payload.audioBase64).length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(payload.audioBase64))) {
        throw new ProtocolValidationError("invalid audio chunk", "invalid_payload");
      }
      break;
    case "voice.transcript.partial":
    case "voice.transcript.final":
      boundedString("text", 64_000, true);
      break;
  }
  return envelope as VoiceEventEnvelope;
}
