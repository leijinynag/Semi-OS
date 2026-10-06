import { combineAbortSignals, providerError } from "./provider-utils.ts";
import type { TtsEvent, TtsProvider } from "./tts.ts";

export interface OpenAiTtsOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly #options: Required<OpenAiTtsOptions>;

  constructor(options: OpenAiTtsOptions) {
    this.#options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      model: options.model ?? "gpt-4o-mini-tts",
      voice: options.voice ?? "alloy",
      timeoutMs: options.timeoutMs ?? 30_000,
      fetch: options.fetch ?? fetch,
    };
  }

  async *synthesize({
    sentenceId,
    text,
    signal: callerSignal,
  }: Parameters<TtsProvider["synthesize"]>[0]): AsyncIterable<TtsEvent> {
    const request = combineAbortSignals(callerSignal, this.#options.timeoutMs);
    try {
      const response = await this.#options.fetch(
        `${this.#options.baseUrl}/audio/speech`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.#options.model,
            voice: this.#options.voice,
            input: text,
            response_format: "mp3",
          }),
          signal: request.signal,
        },
      );
      if (!response.ok) {
        throw await providerError(response);
      }
      if (!response.body) {
        throw new Error("TTS provider returned no response body");
      }
      let sequence = 0;
      for await (const data of response.body) {
        if (sequence === 0) {
          yield { kind: "tts.first_audio_ready", sentenceId };
        }
        yield {
          kind: "tts.audio",
          sentenceId,
          sequence,
          data,
          mimeType: "audio/mpeg",
        };
        sequence += 1;
      }
      yield { kind: "tts.completed", sentenceId };
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "tts.cancelled", sentenceId };
        return;
      }
      yield {
        kind: "tts.error",
        sentenceId,
        code: "cloud_tts_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      request.dispose();
    }
  }
}
