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
  mode?: "qwen" | "fun";
  nearfield?: boolean;
  languageHints?: string[];
  vocabulary?: string[];
  /** Fun-ASR 专用定制词表；须由同一服务、兼容 target_model 创建。 */
  vocabularyId?: string;
}

type SocketEvent =
  { kind: "message"; value: unknown; binary?: Uint8Array } | { kind: "error" } | { kind: "closed" };

function sentenceFrom(value: unknown): {
  text?: string;
  sentenceEnd?: boolean;
  id?: string;
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
    sentenceEnd: typeof sentence.sentence_end === "boolean" ? sentence.sentence_end : undefined,
    id:
      typeof sentence.sentence_id === "number" || typeof sentence.sentence_id === "string"
        ? String(sentence.sentence_id)
        : typeof sentence.begin_time === "number"
          ? String(sentence.begin_time)
          : undefined,
  };
}

function assertPcmChunk(chunk: SttAudioChunk): void {
  if (chunk.mimeType !== "audio/pcm" || chunk.sampleRateHz !== 16_000) {
    throw new Error("DashScope STT requires mono PCM16 audio at 16000 Hz");
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
    Pick<DashScopeSttOptions, "apiKey" | "websocketUrl" | "model" | "timeoutMs" | "createWebSocket">
  >;
  readonly #parameters: Record<string, unknown>;

  constructor(options: DashScopeSttOptions) {
    this.#options = {
      apiKey: options.apiKey,
      websocketUrl: options.websocketUrl ?? "wss://maas.qianwenaiapi.com/api-ws/v1/inference",
      model:
        options.model ??
        (options.mode === "fun" ? "fun-asr-realtime" : "qwen-audio-3.1-asr-flash-streaming"),
      timeoutMs: options.timeoutMs ?? 180_000,
      createWebSocket: options.createWebSocket ?? createProviderWebSocket,
    };
    // 两种模型共用 AOQ 传输，但参数不是互换的，不能仅替换模型字符串。
    this.#parameters = { sample_rate: 16_000, format: "pcm" };
    if (options.mode === "fun") {
      this.#parameters.max_sentence_silence = 800;
      if (options.vocabularyId) {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.vocabularyId))
          throw new Error("invalid Fun-ASR vocabulary_id");
        this.#parameters.vocabulary_id = options.vocabularyId;
      }
    } else {
      if (options.nearfield && this.#options.model.includes("3.1"))
        this.#parameters.vad_model = "near_meeting_16k";
      if (options.languageHints?.length)
        this.#parameters.language_hints = options.languageHints.slice(0, 4);
      if (options.vocabulary?.length)
        this.#parameters.vocabulary = Object.fromEntries(
          options.vocabulary.slice(0, 100).map((word) => [word, 3]),
        );
    }
  }

  async *transcribe({
    audio,
    signal: callerSignal,
  }: Parameters<SttProvider["transcribe"]>[0]): AsyncIterable<SttEvent> {
    const cleanup = new AbortController();
    const request = combineAbortSignals(
      AbortSignal.any([callerSignal, cleanup.signal]),
      this.#options.timeoutMs,
    );
    const queue = new AsyncEventQueue<SocketEvent>();
    const taskId = createTaskId();
    let socket: ProviderWebSocket | undefined;
    let started = false;
    let finished = false;
    let committedText = "";
    let currentSentence = "";
    const committed = new Set<string>();
    let producer: Promise<void> | undefined;
    const iterator = audio[Symbol.asyncIterator]();
    const cancelled = new Promise<IteratorResult<SttAudioChunk>>((resolve) => {
      request.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
        once: true,
      });
    });

    try {
      if (request.signal.aborted) {
        yield { kind: "stt.cancelled" };
        return;
      }
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
              parameters: this.#parameters,
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
          // 发送与接收并行：录音尚未结束时就能把 partial 返回客户端。
          producer = (async () => {
            while (!request.signal.aborted) {
              const next = await Promise.race([iterator.next(), cancelled]);
              if (next.done || request.signal.aborted) break;
              assertPcmChunk(next.value);
              if (next.value.data.byteLength) socket?.send(next.value.data);
            }
            if (!request.signal.aborted)
              socket?.send(
                JSON.stringify({
                  header: {
                    action: "finish-task",
                    task_id: taskId,
                    streaming: "duplex",
                  },
                  payload: { input: {} },
                }),
              );
          })().catch(() => {
            queue.push({ kind: "error" });
          });
        } else if (name === "result-generated") {
          const sentence = sentenceFrom(event.value);
          if (sentence.text) {
            if (sentence.id !== undefined && committed.has(sentence.id)) continue;
            currentSentence = sentence.text.trim();
            const partialText = joinTranscript(committedText, currentSentence);
            yield { kind: "stt.partial", text: partialText };
            if (sentence.sentenceEnd) {
              committedText = partialText;
              if (sentence.id !== undefined) committed.add(sentence.id);
              currentSentence = "";
            }
          }
        } else if (name === "task-failed") {
          // 不静默剥掉热词参数重试：用户必须知道配置没生效。
          throw new Error(
            this.#parameters.vocabulary_id
              ? "Fun-ASR 识别失败，请检查定制词表与网关兼容性；热词未确认生效"
              : "DashScope STT task failed",
          );
        } else if (name === "task-finished") {
          finished = true;
        }
      }
      const finalText = joinTranscript(committedText, currentSentence).trim();
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
          message: error instanceof Error ? error.message : "DashScope STT request failed",
          retryable: true,
        };
      }
    } finally {
      // 取消消费者时也释放音频生产者；AudioInput 的 close 由 Worker 负责。
      socket?.close();
      cleanup.abort();
      await producer;
      request.dispose();
    }
  }
}

function joinTranscript(previous: string, next: string): string {
  return previous + (/[a-z0-9]$/i.test(previous) && /^[a-z0-9]/i.test(next) ? " " : "") + next;
}
