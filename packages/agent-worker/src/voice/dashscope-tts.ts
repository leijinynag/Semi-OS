import { combineAbortSignals } from "./provider-utils.ts";
import type { TtsEvent, TtsProvider } from "./tts.ts";
import {
  AsyncEventQueue,
  createProviderWebSocket,
  createTaskId,
  eventName,
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
  createWebSocket?: ProviderWebSocketFactory;
}

type SocketEvent =
  | { kind: "message"; value?: unknown; binary?: Uint8Array }
  | { kind: "error" }
  | { kind: "closed" };

/**
 * CosyVoice 的 AOQ WebSocket Adapter。
 *
 * run-task 成功后才发送文本，二进制帧按原顺序交给播放器。取消时向 Provider
 * 发送 cancel directive 并立即关闭连接；即使供应商稍后返回音频，上层的
 * generation gate 也会丢弃旧分片。
 */
export class DashScopeTtsProvider implements TtsProvider {
  readonly #options: Required<
    Pick<
      DashScopeTtsOptions,
      | "apiKey"
      | "websocketUrl"
      | "model"
      | "voice"
      | "timeoutMs"
      | "createWebSocket"
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
    };
  }

  async *synthesize({
    sentenceId,
    text,
    signal: callerSignal,
  }: Parameters<TtsProvider["synthesize"]>[0]): AsyncIterable<TtsEvent> {
    const request = combineAbortSignals(callerSignal, this.#options.timeoutMs);
    const queue = new AsyncEventQueue<SocketEvent>();
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
              task: "tts",
              function: "SpeechSynthesizer",
              model: this.#options.model,
              parameters: {
                text_type: "PlainText",
                voice: this.#options.voice,
                format: "mp3",
                sample_rate: 22_050,
              },
              input: {},
            },
          }),
        );
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          queue.push({
            kind: "message",
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
        if (event.binary) {
          if (sequence === 0) {
            yield { kind: "tts.first_audio_ready", sentenceId };
          }
          yield {
            kind: "tts.audio",
            sentenceId,
            sequence,
            data: event.binary,
            mimeType: "audio/mpeg",
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
