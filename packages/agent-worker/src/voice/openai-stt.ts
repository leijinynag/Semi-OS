import { combineAbortSignals, providerError } from "./provider-utils.ts";
import type { SttAudioChunk, SttEvent, SttProvider } from "./stt.ts";

export interface OpenAiSttOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

async function collectAudio(
  audio: AsyncIterable<SttAudioChunk>,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let mimeType = "audio/webm";
  let expectedSequence = 0;
  for await (const chunk of audio) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (chunk.sequence !== expectedSequence) {
      throw new Error(
        `audio chunk sequence mismatch: expected ${expectedSequence}, received ${chunk.sequence}`,
      );
    }
    expectedSequence += 1;
    mimeType = chunk.mimeType;
    chunks.push(chunk.data);
    size += chunk.data.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType };
}

function parseSseEvent(block: string): { event?: string; data?: unknown } {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    }
  }
  if (data.length === 0 || data[0] === "[DONE]") {
    return { event };
  }
  return { event, data: JSON.parse(data.join("\n")) as unknown };
}

function eventText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ("delta" in value && typeof value.delta === "string") {
    return value.delta;
  }
  if ("text" in value && typeof value.text === "string") {
    return value.text;
  }
  if (
    "transcript" in value &&
    typeof value.transcript === "object" &&
    value.transcript !== null &&
    "text" in value.transcript &&
    typeof value.transcript.text === "string"
  ) {
    return value.transcript.text;
  }
  return undefined;
}

/**
 * OpenAI 兼容的云端 STT Adapter。
 *
 * MVP 在用户松开快捷键后提交一个完整录音文件，并消费 Provider 的 SSE 转写
 * 增量；采集仍然是分片的，因此未来切换实时 websocket 不影响上层接口。
 */
export class OpenAiSttProvider implements SttProvider {
  readonly #options: Required<
    Pick<OpenAiSttOptions, "apiKey" | "baseUrl" | "model" | "timeoutMs">
  > & { fetch: typeof fetch };

  constructor(options: OpenAiSttOptions) {
    this.#options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      model: options.model ?? "gpt-4o-mini-transcribe",
      timeoutMs: options.timeoutMs ?? 30_000,
      fetch: options.fetch ?? fetch,
    };
  }

  async *transcribe({
    audio,
    signal: callerSignal,
  }: Parameters<SttProvider["transcribe"]>[0]): AsyncIterable<SttEvent> {
    const request = combineAbortSignals(callerSignal, this.#options.timeoutMs);
    try {
      const { bytes, mimeType } = await collectAudio(audio, request.signal);
      if (bytes.byteLength === 0) {
        yield { kind: "stt.silence" };
        return;
      }
      const form = new FormData();
      form.set("model", this.#options.model);
      form.set("stream", "true");
      form.set("response_format", "json");
      form.set(
        "file",
        new Blob([bytes], { type: mimeType }),
        mimeType.includes("wav") ? "speech.wav" : "speech.webm",
      );
      const response = await this.#options.fetch(
        `${this.#options.baseUrl}/audio/transcriptions`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#options.apiKey}` },
          body: form,
          signal: request.signal,
        },
      );
      if (!response.ok) {
        throw await providerError(response);
      }
      if (!response.body) {
        throw new Error("STT provider returned no response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let transcript = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const parsed = parseSseEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          const text = eventText(parsed.data);
          if (text) {
            if (parsed.event?.includes("delta")) {
              transcript += text;
              yield { kind: "stt.partial", text: transcript };
            } else {
              transcript = text;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      const finalText = transcript.trim();
      yield finalText
        ? { kind: "stt.final", text: finalText }
        : { kind: "stt.silence" };
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "stt.cancelled" };
        return;
      }
      yield {
        kind: "stt.error",
        code: "cloud_stt_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      request.dispose();
    }
  }
}
