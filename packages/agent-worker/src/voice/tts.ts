export interface TtsSynthesisInput {
  sentenceId: string;
  text: string;
  signal: AbortSignal;
}

export type TtsEvent =
  | {
      kind: "tts.audio";
      sentenceId: string;
      sequence: number;
      data: Uint8Array;
      mimeType: string;
    }
  | { kind: "tts.first_audio_ready"; sentenceId: string }
  | { kind: "tts.completed"; sentenceId: string }
  | {
      kind: "tts.error";
      sentenceId: string;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { kind: "tts.cancelled"; sentenceId: string };

/**
 * TTS Provider 按完整句子生成有序音频分片。
 *
 * 首段音频必须先发 `tts.first_audio_ready`，这样上层能准确记录首音频延迟，
 * 而不需要根据字节数量猜测 Provider 是否已经开始响应。
 */
export interface TtsProvider {
  synthesize(input: TtsSynthesisInput): AsyncIterable<TtsEvent>;
}
