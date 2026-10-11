import { combineAbortSignals } from "./provider-utils.ts";
import { VOICE_PCM_MIME } from "@semi-os/protocol";
import type { TtsEvent, TtsProvider } from "./tts.ts";
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

export interface DashScopeTtsOptions {
  apiKey: string;
  websocketUrl?: string;
  model?: string;
  voice: string;
  timeoutMs?: number;
  /** 桌面使用 PCM 流；MP3 留给离线录音评估和兼容性排查。 */
  format?: "mp3" | "pcm";
  createWebSocket?: ProviderWebSocketFactory;
}

type SocketEvent =
  | { kind: "open" }
  | { kind: "message"; value?: unknown; binary?: Uint8Array }
  | { kind: "error" }
  | { kind: "closed" };

interface TtsConnection {
  socket: ProviderWebSocket;
  queue: AsyncEventQueue<SocketEvent>;
  release: () => void;
}

/**
 * CosyVoice 的 AOQ WebSocket Adapter。
 *
 * run-task 成功后才发送文本，二进制帧按原顺序交给播放器。取消时向 Provider
 * 发送 cancel directive 并立即关闭连接；即使供应商稍后返回音频，上层的
 * generation gate 也会丢弃旧分片。
 */
export class DashScopeTtsProvider implements TtsProvider {
  #prepared?: TtsConnection;
  readonly #options: Required<
    Pick<
      DashScopeTtsOptions,
      | "apiKey"
      | "websocketUrl"
      | "model"
      | "voice"
      | "timeoutMs"
      | "createWebSocket"
      | "format"
    >
  >;

  constructor(options: DashScopeTtsOptions) {
    this.#options = {
      apiKey: options.apiKey,
      websocketUrl:
        options.websocketUrl ??
        "wss://maas.qianwenaiapi.com/api-ws/v1/inference",
      model: options.model ?? "cosyvoice-v3.5-plus",
      voice: options.voice,
      timeoutMs: options.timeoutMs ?? 30_000,
      createWebSocket: options.createWebSocket ?? createProviderWebSocket,
      format: options.format ?? "mp3",
    };
  }

  /**
   * 用户说话期间只做 WebSocket 握手，不提前 run-task。首句到来后领取一次，
   * 避免改变合成协议或提前播报；长录音、取消及失败均清理闲置连接。
   */
  prepare(signal: AbortSignal): void {
    if (signal.aborted || this.#prepared) return;
    let connection: TtsConnection;
    try { connection = this.#connect(); } catch { return; }
    this.#prepared = connection;
    const discard = () => {
      if (this.#prepared !== connection) return;
      this.#prepared = undefined;
      connection.release();
      connection.socket.close();
    };
    const timer = setTimeout(discard, 15_000);
    const release = connection.release;
    connection.release = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", discard);
      release();
    };
    signal.addEventListener("abort", discard, { once: true });
    connection.socket.on("error", discard);
    connection.socket.on("close", discard);
  }

  #connect(): TtsConnection {
    const queue = new AsyncEventQueue<SocketEvent>();
    const socket = this.#options.createWebSocket(this.#options.websocketUrl, {
      Authorization: `Bearer ${this.#options.apiKey}`,
    });
    socket.on("open", () => queue.push({ kind: "open" }));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        queue.push({ kind: "message", binary: rawDataToBytes(data) });
      } else {
        try { queue.push({ kind: "message", value: parseDashScopeMessage(data) }); }
        catch { queue.push({ kind: "error" }); }
      }
    });
    socket.on("error", () => queue.push({ kind: "error" }));
    socket.on("close", () => queue.push({ kind: "closed" }));
    return { socket, queue, release: () => {} };
  }

  async *synthesize({
    sentenceId,
    text,
    signal: callerSignal,
  }: Parameters<TtsProvider["synthesize"]>[0]): AsyncIterable<TtsEvent> {
    const request = combineAbortSignals(callerSignal, this.#options.timeoutMs);
    let queue = new AsyncEventQueue<SocketEvent>();
    const taskId = createTaskId();
    let socket: ProviderWebSocket | undefined;
    let started = false;
    let sequence = 0;

    const finish = (directive?: "cancel") => {
      socket?.send(
        JSON.stringify({
          header: {
            action: "finish-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: { input: directive ? { directive } : {} },
        }),
      );
    };

    try {
      if (request.signal.aborted) {
        yield { kind: "tts.cancelled", sentenceId };
        return;
      }
      const connection = this.#prepared ?? this.#connect();
      this.#prepared = undefined;
      connection.release();
      socket = connection.socket;
      queue = connection.queue;
      const runTask = () => {
        socket!.send(
          JSON.stringify({
            header: {
              action: "run-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "tts",
              function: "SpeechSynthesizer",
              model: this.#options.model,
              parameters: {
                text_type: "PlainText",
                voice: this.#options.voice,
                format: this.#options.format,
                sample_rate: 22_050,
                word_timestamp_enabled: true,
              },
              input: {},
            },
          }),
        );
      };
      request.signal.addEventListener(
        "abort",
        () => {
          if (started) {
            finish("cancel");
          }
          socket?.close();
          queue.push({ kind: "closed" });
        },
        { once: true },
      );

      while (true) {
        const event = await queue.next();
        if (request.signal.aborted) {
          yield { kind: "tts.cancelled", sentenceId };
          return;
        }
        if (event.kind === "error" || event.kind === "closed") {
          throw new Error("DashScope TTS connection ended before completion");
        }
        if (event.kind === "open") {
          runTask();
          continue;
        }
        if (event.binary) {
          if (sequence === 0) {
            yield { kind: "tts.first_audio_ready", sentenceId };
          }
          yield {
            kind: "tts.audio",
            sentenceId,
            sequence,
            data: event.binary,
            mimeType: this.#options.format === "pcm" ? VOICE_PCM_MIME : "audio/mpeg",
          };
          sequence += 1;
          continue;
        }
        const name = eventName(event.value);
        if (name === "task-started" && !started) {
          started = true;
          socket.send(
            JSON.stringify({
              header: {
                action: "continue-task",
                task_id: taskId,
                streaming: "duplex",
              },
              payload: { input: { text } },
            }),
          );
          finish();
        } else if (name === "result-generated") {
          // 官方 CosyVoice 服务端事件的 begin/end_time 单位为毫秒。
          // 供应商可能先发送局部时间轴；客户端验证完整覆盖后才启用字级同步，
          // 否则退化为整句。所有时间轴事件都不能阻塞音频。
          const value = event.value;
          if (isRecord(value) && isRecord(value.payload) && isRecord(value.payload.output)) {
            const output = value.payload.output;
            if (["sentence-begin", "sentence-synthesis", "sentence-end"].includes(String(output.type)) && isRecord(output.sentence) && Array.isArray(output.sentence.words)) {
              const words = output.sentence.words;
              if (words.length > 0 && words.length <= 4096 && words.every((word) =>
                isRecord(word) && typeof word.text === "string" &&
                Number.isSafeInteger(word.begin_time) && Number.isSafeInteger(word.end_time) &&
                Number(word.begin_time) >= 0 && Number(word.end_time) >= Number(word.begin_time) &&
                Number(word.end_time) <= 600_000)) {
                yield { kind: "tts.timestamps", sentenceId, words: words.map((word) => ({
                  text: String(word.text), startMs: Number(word.begin_time), endMs: Number(word.end_time),
                })) };
              }
            }
          }
        } else if (name === "task-failed") {
          throw new Error("DashScope TTS task failed");
        } else if (name === "task-finished") {
          yield { kind: "tts.completed", sentenceId };
          return;
        }
      }
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "tts.cancelled", sentenceId };
      } else {
        yield {
          kind: "tts.error",
          sentenceId,
          code: "cloud_tts_failed",
          message:
            error instanceof Error
              ? error.message
              : "DashScope TTS request failed",
          retryable: true,
        };
      }
    } finally {
      socket?.close();
      request.dispose();
    }
  }
}
