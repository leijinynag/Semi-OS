export interface TtsSynthesisInput {
  sentenceId: string;
  text: string;
  signal: AbortSignal;
}

export type TtsEvent =
  | { kind: "tts.timestamps"; sentenceId: string; words: WordTiming[] }
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
  /** 可选连接预热，不提交文本、不生成音频；取消必须释放尚未领取的连接。 */
  prepare?(signal: AbortSignal): void;
  synthesize(input: TtsSynthesisInput): AsyncIterable<TtsEvent>;
}
export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}
