import type { SttEvent, SttProvider } from "./stt.ts";
import type { TtsEvent, TtsProvider } from "./tts.ts";

export class FakeSttProvider implements SttProvider {
  readonly transcript: string;

  constructor(transcript: string) {
    this.transcript = transcript;
  }

  async *transcribe({
    audio,
    signal,
  }: Parameters<SttProvider["transcribe"]>[0]): AsyncIterable<SttEvent> {
    for await (const _chunk of audio) {
      if (signal.aborted) {
        yield { kind: "stt.cancelled" };
        return;
      }
    }
    const midpoint = Math.max(1, Math.floor(this.transcript.length / 2));
    yield { kind: "stt.partial", text: this.transcript.slice(0, midpoint) };
    yield this.transcript
      ? { kind: "stt.final", text: this.transcript }
      : { kind: "stt.silence" };
  }
}

export class FakeTtsProvider implements TtsProvider {
  readonly spoken: string[] = [];

  async *synthesize({
    sentenceId,
    text,
    signal,
  }: Parameters<TtsProvider["synthesize"]>[0]): AsyncIterable<TtsEvent> {
    if (signal.aborted) {
      yield { kind: "tts.cancelled", sentenceId };
      return;
    }
    this.spoken.push(text);
    yield { kind: "tts.first_audio_ready", sentenceId };
    yield {
      kind: "tts.audio",
      sentenceId,
      sequence: 0,
      data: new TextEncoder().encode(text),
      mimeType: "audio/fake",
    };
    yield { kind: "tts.completed", sentenceId };
  }
}
