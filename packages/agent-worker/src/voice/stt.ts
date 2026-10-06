export interface SttAudioChunk {
  sequence: number;
  data: Uint8Array;
  mimeType: string;
  sampleRateHz?: number;
}

export type SttEvent =
  | { kind: "stt.partial"; text: string }
  | { kind: "stt.final"; text: string }
  | { kind: "stt.silence" }
  | {
      kind: "stt.error";
      code: string;
      message: string;
      retryable: boolean;
    }
  | { kind: "stt.cancelled" };

export interface SttTranscriptionInput {
  audio: AsyncIterable<SttAudioChunk>;
  signal: AbortSignal;
}

/**
 * STT Provider 的稳定边界。
 *
 * 调用方只依赖标准事件，不依赖厂商的 websocket/SSE 消息。实现必须保证至多
 * 一个终态事件（final、silence、error 或 cancelled），并保持 partial 顺序。
 */
export interface SttProvider {
  transcribe(input: SttTranscriptionInput): AsyncIterable<SttEvent>;
}
