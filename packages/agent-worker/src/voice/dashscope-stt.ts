import { combineAbortSignals } from "./provider-utils.ts";
import type { SttAudioChunk, SttEvent, SttProvider } from "./stt.ts";
import {
  AsyncEventQueue,
  createProviderWebSocket,
  createTaskId,
  eventName,
  isRecord,
  parseDashScopeMessage,
  rawDataToBytes,
  type ProviderWebSocket,
  type ProviderWebSocketFactory,
} from "./dashscope-websocket.ts";

export interface DashScopeSttOptions {
  apiKey: string;
  websocketUrl?: string;
  model?: string;
  timeoutMs?: number;
  createWebSocket?: ProviderWebSocketFactory;
}

type SocketEvent =
  | { kind: "message"; value: unknown; binary?: Uint8Array }
  | { kind: "error" }
  | { kind: "closed" };

function sentenceFrom(value: unknown): {
  text?: string;
  sentenceEnd?: boolean;
} {
  if (
    !isRecord(value) ||
    !isRecord(value.payload) ||
    !isRecord(value.payload.output) ||
    !isRecord(value.payload.output.sentence)
  ) {
    return {};
  }
  const sentence = value.payload.output.sentence;
  return {
    text: typeof sentence.text === "string" ? sentence.text : undefined,
    sentenceEnd:
      typeof sentence.sentence_end === "boolean"
        ? sentence.sentence_end
        : undefined,
  };
}

function assertPcmChunk(chunk: SttAudioChunk): void {
  if (chunk.mimeType !== "audio/pcm" || chunk.sampleRateHz !== 16_000) {
    throw new Error(
      "DashScope STT requires mono PCM16 audio at 16000 Hz",
    );
  }
}

/**
 * DashScope Qwen ASR 的 AOQ WebSocket Adapter。
 *
 * 鉴权只发生在 Worker 到云端的握手中；音频必须等 task-started 后再发送，
 * 并保持前端生成的 16 kHz 单声道 PCM16 分片顺序。上层只能看到归一化事件，
 * 不能接触 API Key 或供应商原始错误正文。
 */
export class DashScopeSttProvider implements SttProvider {
  readonly #options: Required<
    Pick<
      DashScopeSttOptions,
      "apiKey" | "websocketUrl" | "model" | "timeoutMs" | "createWebSocket"
    >
  >;

  constructor(options: DashScopeSttOptions) {
    this.#options = {
      apiKey: options.apiKey,
      websocketUrl:
        options.websocketUrl ??
        "wss://maas.qianwenaiapi.com/api-ws/v1/inference",
      model: options.model ?? "qwen-audio-3.1-asr-flash-streaming",
      timeoutMs: options.timeoutMs ?? 30_000,
      createWebSocket: options.createWebSocket ?? createProviderWebSocket,
    };
  }

  async *transcribe({
    audio,
    signal: callerSignal,
  }: Parameters<SttProvider["transcribe"]>[0]): AsyncIterable<SttEvent> {
    const request = combineAbortSignals(callerSignal, this.#options.timeoutMs);
    const queue = new AsyncEventQueue<SocketEvent>();
    const taskId = createTaskId();
    let socket: ProviderWebSocket | undefined;
    let started = false;
    let finished = false;
    let committedText = "";
    let currentSentence = "";

    try {
      socket = this.#options.createWebSocket(this.#options.websocketUrl, {
        Authorization: `Bearer ${this.#options.apiKey}`,
      });
      socket.on("open", () => {
        socket?.send(
          JSON.stringify({
            header: {
              action: "run-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: this.#options.model,
              parameters: { sample_rate: 16_000, format: "pcm" },
              input: {},
            },
          }),
        );
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          queue.push({
            kind: "message",
            value: undefined,
            binary: rawDataToBytes(data),
          });
          return;
        }
        try {
          queue.push({ kind: "message", value: parseDashScopeMessage(data) });
        } catch {
          queue.push({ kind: "error" });
        }
      });
      socket.on("error", () => queue.push({ kind: "error" }));
      socket.on("close", () => queue.push({ kind: "closed" }));
      request.signal.addEventListener(
        "abort",
        () => {
          socket?.close();
          queue.push({ kind: "closed" });
        },
        { once: true },
      );

      while (!finished) {
        const event = await queue.next();
        if (request.signal.aborted) {
          yield { kind: "stt.cancelled" };
          return;
        }
        if (event.kind === "error" || event.kind === "closed") {
          throw new Error("DashScope STT connection ended before completion");
        }
        const name = eventName(event.value);
        if (name === "task-started" && !started) {
          started = true;
          let hasAudio = false;
          for await (const chunk of audio) {
            assertPcmChunk(chunk);
            if (request.signal.aborted) {
              yield { kind: "stt.cancelled" };
              return;
            }
            hasAudio ||= chunk.data.byteLength > 0;
            if (chunk.data.byteLength > 0) {
              socket.send(chunk.data);
            }
          }
          if (!hasAudio) {
            socket.close();
            yield { kind: "stt.silence" };
            return;
          }
          socket.send(
            JSON.stringify({
              header: {
                action: "finish-task",
                task_id: taskId,
                streaming: "duplex",
              },
              payload: { input: {} },
            }),
          );
        } else if (name === "result-generated") {
          const sentence = sentenceFrom(event.value);
          if (sentence.text) {
            currentSentence = sentence.text.trim();
            const partialText = [committedText, currentSentence]
              .filter(Boolean)
              .join(" ");
            yield { kind: "stt.partial", text: partialText };
            if (sentence.sentenceEnd) {
              committedText = partialText;
              currentSentence = "";
            }
          }
        } else if (name === "task-failed") {
          throw new Error("DashScope STT task failed");
        } else if (name === "task-finished") {
          finished = true;
        }
      }
      const finalText = [committedText, currentSentence]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (finalText) {
        yield { kind: "stt.final", text: finalText };
      } else {
        yield { kind: "stt.silence" };
      }
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "stt.cancelled" };
      } else {
        yield {
          kind: "stt.error",
          code: "cloud_stt_failed",
          message:
            error instanceof Error
              ? error.message
              : "DashScope STT request failed",
          retryable: true,
        };
      }
    } finally {
      socket?.close();
      request.dispose();
    }
  }
}
