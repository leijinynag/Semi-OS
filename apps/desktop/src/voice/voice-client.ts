import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { VoicePlayer } from "./voice-player";
import { PcmRecorder } from "./pcm-recorder";

export type VoiceClientState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export interface VoiceClientSnapshot {
  state: VoiceClientState;
  transcript: string;
  assistantText: string;
  error?: string;
}

interface WorkerEnvelope {
  direction: "response" | "event" | "error";
  requestId: string;
  kind: string;
  payload: Record<string, unknown>;
}

type VoiceClientListener = (snapshot: VoiceClientSnapshot) => void;

function createId(prefix: "req" | "task"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * 桌面语音客户端只负责采集、协议发送和播放，不持有 Provider 凭证或 Pi 状态。
 *
 * 麦克风输入被转换为 16 kHz 单声道 PCM16；所有 invoke 通过 promise 链
 * 串行发送，保证 Worker 看到严格递增 sequence。React 不持有云端凭证。
 */
export class VoiceClient {
  readonly #listeners = new Set<VoiceClientListener>();
  readonly #player = new VoicePlayer();
  readonly #sessionId = `session_${crypto.randomUUID().replaceAll("-", "_")}`;
  #snapshot: VoiceClientSnapshot = {
    state: "idle",
    transcript: "",
    assistantText: "",
  };
  #requestId?: string;
  #taskId?: string;
  #recorder?: PcmRecorder;
  #recording = false;
  #stream?: MediaStream;
  #starting?: Promise<void>;
  #sequence = 0;
  #sendChain: Promise<void> = Promise.resolve();
  #unlisten: UnlistenFn[] = [];

  subscribe(listener: VoiceClientListener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    const unlisten = await listen<WorkerEnvelope>(
      "host://worker-message",
      ({ payload }) => this.#onWorkerMessage(payload),
    );
    this.#unlisten.push(unlisten);
  }

  async start(): Promise<void> {
    if (this.#starting) {
      return this.#starting;
    }
    if (this.#recording) {
      return;
    }
    this.#starting = this.#startRecording().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #startRecording(): Promise<void> {
    try {
      const interruptsActiveTurn =
        this.#snapshot.state === "transcribing" ||
        this.#snapshot.state === "thinking" ||
        this.#snapshot.state === "speaking";
      this.#player.stop();
      // 用户在 Agent 工作或播报时再次按键，先停止旧输出并暂停当前生成。
      // 新语音转写完成后作为同一 Pi Session 的后续指令继续，而非新建会话。
      if (interruptsActiveTurn && this.#taskId) {
        await this.interrupt("pause");
      }
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.#requestId = createId("req");
      this.#taskId = createId("task");
      this.#sequence = 0;
      this.#sendChain = this.#send("voice.turn.start", {
        sessionId: this.#sessionId,
        taskId: this.#taskId,
        cwd: ".",
        mimeType: "audio/pcm",
        sampleRateHz: 16_000,
        // pause 已等待当前 Pi 轮次停止；后续语音应在同一 Session 上启动新
        // prompt。Pi 的 followUp 只为正在运行的循环排队，空闲时不会自行启动。
        action: "prompt",
      });
      this.#recorder = new PcmRecorder({
        onChunk: (data) => {
          if (data.byteLength === 0) {
            return;
          }
          const sequence = this.#sequence++;
          this.#sendChain = this.#sendChain.then(() =>
            this.#send("voice.audio.append", {
              sequence,
              audioBase64: toBase64(data),
            }),
          );
        },
      });
      await this.#recorder.start(this.#stream);
      this.#recording = true;
      this.#update({
        state: "listening",
        transcript: "",
        assistantText: "",
        error: undefined,
      });
    } catch (error) {
      this.#update({
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    // 快速点按时 release 可能先于 getUserMedia 返回；等待启动完成后再停止，
    // 否则录音器会在按键已松开后继续采集，形成一次无法提交的悬空录音。
    await this.#starting;
    const recorder = this.#recorder;
    if (!recorder || !this.#recording) {
      return;
    }
    this.#recording = false;
    await recorder.stop();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = undefined;
    this.#recorder = undefined;
    await this.#sendChain;
    await this.#send("voice.turn.commit", {
      lastSequence: this.#sequence - 1,
    });
    this.#update({ state: "transcribing" });
  }

  async interrupt(mode: "pause" | "cancel"): Promise<void> {
    if (!this.#taskId) {
      return;
    }
    this.#player.stop();
    await this.#send("voice.interrupt", {
      taskId: this.#taskId,
      mode,
    });
  }

  dispose(): void {
    this.#recording = false;
    void this.#recorder?.stop();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#player.stop();
    this.#unlisten.forEach((unlisten) => unlisten());
    this.#unlisten = [];
  }

  async #send(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.#requestId) {
      throw new Error("voice turn has not started");
    }
    await invoke("send_worker_request", {
      envelope: {
        direction: "request",
        protocolVersion: 1,
        requestId: this.#requestId,
        kind,
        payload,
      },
    });
  }

  #onWorkerMessage(message: WorkerEnvelope): void {
    if (message.requestId !== this.#requestId) {
      return;
    }
    if (message.direction === "error") {
      this.#update({
        state: "error",
        error: String(message.payload.message ?? "语音请求失败"),
      });
      return;
    }
    if (message.direction !== "event") {
      return;
    }
    if (message.kind === "voice.state") {
      this.#update({ state: message.payload.state as VoiceClientState });
    } else if (
      message.kind === "voice.transcript.partial" ||
      message.kind === "voice.transcript.final"
    ) {
      this.#update({ transcript: String(message.payload.text ?? "") });
    } else if (message.kind === "voice.assistant.text_delta") {
      this.#update({
        assistantText:
          message.payload.source === "acknowledgement"
            ? String(message.payload.text ?? "")
            : `${this.#snapshot.assistantText}${String(message.payload.text ?? "")}`,
      });
    } else if (message.kind === "voice.audio.chunk") {
      this.#player.append(
        String(message.payload.sentenceId),
        String(message.payload.mimeType),
        String(message.payload.audioBase64),
        Boolean(message.payload.first),
      );
    } else if (message.kind === "voice.audio.completed") {
      this.#player.complete(String(message.payload.sentenceId));
    } else if (message.kind === "voice.audio.stop") {
      this.#player.stop();
    } else if (message.kind === "voice.error") {
      this.#update({
        state: "error",
        error: String(message.payload.message ?? "语音处理失败"),
      });
    }
  }

  #update(patch: Partial<VoiceClientSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach((listener) => listener(this.#snapshot));
  }
}
