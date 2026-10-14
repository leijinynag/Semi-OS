import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  assertValidEnvelope,
  parseVoiceEvent,
  TEXT_INPUT_MAX_LENGTH,
  VOICE_PCM_MIME,
} from "@semi-os/protocol";
import { VoicePlayer } from "./voice-player.ts";
import { PcmRecorder } from "./pcm-recorder.ts";
import { spokenPrefix, validateWords, type SpeechWord } from "./speech-sync.ts";
import type { PlaybackEvent } from "./voice-player.ts";

export type VoiceClientState =
  "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "interrupted" | "error";

export interface VoiceClientSnapshot {
  state: VoiceClientState;
  transcript: string;
  assistantText: string;
  error?: string;
  report?: string;
}

interface WorkerEnvelope {
  direction: "response" | "event" | "error";
  requestId: string;
  kind: string;
  payload: Record<string, unknown>;
}

type VoiceClientListener = (snapshot: VoiceClientSnapshot) => void;

interface CaptureTurn {
  token: number;
  requestId: string;
  taskId: string;
  pressedAt: number;
  releasedAt?: number;
  firstSample: boolean;
  silent?: boolean;
  failed?: boolean;
  sequence: number;
  buffered: Uint8Array[];
  ready: boolean;
  capture: Promise<void>;
  setup: Promise<void>;
  send: Promise<void>;
  stop?: Promise<void>;
}

export interface VoiceSettings {
  enabled: boolean;
  prewarm: boolean;
}

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
  // 原生 WebView 的 WebAudio 有信号但无声时，使用直接媒体输出按句播放。
  // 时间轴仍来自实际 playing/timeupdate，不由合成结束推进。
  readonly #player = new VoicePlayer((event) => this.#onPlayback(event), { mediaOutput: true });
  readonly audioLevel = this.#player.audioLevel;
  readonly #sentences = new Map<
    string,
    { text: string; purpose: string; words?: SpeechWord[]; revealed: string }
  >();
  #generated = false;
  #playbackFailed = false;
  #summary = "";
  #lastPublish = 0;
  #publishing = false;
  #pendingSnapshot?: Record<string, unknown>;
  #acceptMessages = true;
  #sessionId = `session_${crypto.randomUUID().replaceAll("-", "_")}`;
  #snapshot: VoiceClientSnapshot = {
    state: "idle",
    transcript: "",
    assistantText: "",
  };
  #requestId?: string;
  #taskId?: string;
  #recorder?: PcmRecorder;
  #stream?: MediaStream;
  #deviceReady = false;
  #devicePromise?: Promise<void>;
  #deviceEpoch = 0;
  #disposed = false;
  #sessionChanging = false;
  #settings: VoiceSettings = { enabled: true, prewarm: true };
  #capturing?: CaptureTurn;
  #turns = new Map<number, CaptureTurn>();
  #token = 0;
  // 仅设备冲刷串行，不让网络提交链阻塞下一轮本地采集。
  #captureTail: Promise<void> = Promise.resolve();
  #captureClosing = 0;
  #rpcTail: Promise<void> = Promise.resolve();
  #lastStop?: Promise<void>;
  #unlisten: UnlistenFn[] = [];
  #releasedAt?: number;
  #firstPlayback = false;
  #firstText = false;
  #firstModel = false;
  #firstTts = false;
  #lastPlaybackDiagnostic?: string;

  subscribe(listener: VoiceClientListener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    const unlisten = await listen<WorkerEnvelope>("host://worker-message", ({ payload }) =>
      this.#onWorkerMessage(payload),
    );
    this.#unlisten.push(unlisten);
    this.#recorder = new PcmRecorder({
      // 录音与播放使用独立上下文，避免输入设备启动/关闭改变播放出口。
      // 播放仍由唯一 VoicePlayer 持有，不新增窗口级播放器。
      onDiagnostics: (diagnostics, token) => {
        console.info("麦克风采集质量", diagnostics);
        const turn = this.#turns.get(token);
        if (turn) turn.silent = diagnostics.rms < 0.00005 && diagnostics.peak < 0.001;
      },
      onFirstSample: (token) => {
        const turn = this.#turns.get(token);
        if (turn && !turn.firstSample) {
          turn.firstSample = true;
          this.#logTiming(
            "client.press_to_first_sample",
            performance.now() - turn.pressedAt,
            turn.requestId,
          );
        }
      },
      onChunk: (data, token) => {
        const turn = this.#turns.get(token);
        if (!turn || turn.failed || !data.byteLength) return;
        if (!turn.ready) {
          if (turn.buffered.length < 300) turn.buffered.push(data);
          else {
            turn.failed = true;
            if (this.#capturing === turn)
              void this.stop().then(() => {
                if (turn.token === this.#token)
                  this.#update({ state: "error", error: "语音握手等待过久，请重试。" });
              });
          }
          return;
        }
        this.#appendAudio(turn, data);
      },
    });
    // 预热失败不能阻止快捷键监听安装；真正录音时重新尝试并报告错误。
    await this.#recorder.prepare().catch(() => {});
    this.#unlisten.push(
      await listen<VoiceSettings>("host://voice-settings", ({ payload }) => {
        void this.configure(payload);
      }),
    );
    const settings = await invoke<VoiceSettings>("get_voice_settings").catch(() => undefined);
    if (typeof settings?.enabled === "boolean" && typeof settings?.prewarm === "boolean")
      this.#settings = settings;
    if (this.#settings.enabled && this.#settings.prewarm) {
      // 权限弹窗可能长时间悬而未决，不能阻止控制器安装按键监听。
      const token = this.#token;
      void this.#ensureDevice().catch(() => {
        this.#reportPrewarmError(token, "麦克风尚未授权，请在系统设置中允许访问后按键重试。");
      });
    }
    const recover = () => {
      if (!this.#capturing) void this.#resetDevice();
    };
    navigator.mediaDevices.addEventListener?.("devicechange", recover);
    const resume = () => {
      if (
        !document.hidden &&
        !this.#capturing &&
        this.#settings.enabled &&
        this.#settings.prewarm
      ) {
        void this.#ensureDevice().catch(() => {});
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
    this.#unlisten.push(() => {
      navigator.mediaDevices.removeEventListener?.("devicechange", recover);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    });
  }

  async configure(settings: VoiceSettings): Promise<void> {
    if (typeof settings?.enabled !== "boolean" || typeof settings?.prewarm !== "boolean") return;
    this.#settings = settings;
    if (!settings.enabled) {
      const stopping = this.stop();
      // 设备释放只等待本地尾部，不因云端/Host 提交卡住而继续占用麦克风。
      await this.#captureTail;
      if (!this.#settings.enabled) this.#releaseDevice();
      await stopping;
      await this.interrupt("cancel").catch(() => {});
    } else if (settings.prewarm) {
      const token = this.#token;
      await this.#ensureDevice().catch(() =>
        this.#reportPrewarmError(token, "麦克风预热失败，请检查权限。"),
      );
    } else if (!this.#capturing) {
      await this.#captureTail;
      if (!this.#settings.prewarm && !this.#capturing) this.#releaseDevice();
    }
  }

  /** 预热是设备后台工作，迟到的失败不能覆盖文字或已开始的语音轮次。 */
  #reportPrewarmError(token: number, error: string): void {
    if (
      !this.#disposed &&
      this.#settings.enabled &&
      token === this.#token &&
      ["idle", "error"].includes(this.#snapshot.state)
    )
      this.#update({ state: "error", error });
  }

  async #ensureDevice(): Promise<void> {
    if (
      this.#deviceReady &&
      this.#stream?.getTracks().every((track) => track.readyState !== "ended")
    ) {
      await this.#recorder?.attach(this.#stream);
      return;
    }
    if (this.#devicePromise) return this.#devicePromise;
    const epoch = this.#deviceEpoch;
    const startedAt = performance.now();
    this.#devicePromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (epoch !== this.#deviceEpoch || this.#disposed || !this.#settings.enabled) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("麦克风初始化已取消");
      }
      this.#stream = stream;
      try {
        await this.#recorder!.attach(stream);
        if (epoch !== this.#deviceEpoch || this.#disposed) throw new Error("麦克风初始化已取消");
        this.#deviceReady = true;
        const input = stream.getAudioTracks?.()[0]?.getSettings?.();
        if (input)
          console.info("麦克风设备参数", {
            sampleRateHz: input.sampleRate,
            channelCount: input.channelCount,
            echoCancellation: input.echoCancellation,
            noiseSuppression: input.noiseSuppression,
            autoGainControl: input.autoGainControl,
          });
        this.#logTiming("client.device_ready", performance.now() - startedAt);
        for (const track of stream.getTracks())
          track.addEventListener?.(
            "ended",
            () => {
              if (this.#stream !== stream || this.#disposed) return;
              this.#deviceReady = false;
              if (this.#capturing) {
                const turn = this.#capturing;
                turn.failed = true;
                void this.stop().then(() => {
                  if (turn.token === this.#token)
                    this.#update({ state: "error", error: "麦克风设备已断开，请重新录音。" });
                });
              } else void this.#resetDevice();
            },
            { once: true },
          );
      } catch (error) {
        // 旧的设备初始化失败不能关闭已经替换的新设备。
        if (this.#stream === stream) this.#releaseDevice();
        else stream.getTracks().forEach((track) => track.stop());
        throw error;
      }
    })();
    try {
      await this.#devicePromise;
    } finally {
      this.#devicePromise = undefined;
    }
  }

  #releaseDevice(): void {
    this.#deviceEpoch++;
    this.#deviceReady = false;
    this.#recorder?.detach();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = undefined;
  }

  async #resetDevice(): Promise<void> {
    this.#releaseDevice();
    await this.#devicePromise?.catch(() => {});
    if (!this.#disposed && this.#settings.enabled && this.#settings.prewarm) {
      await this.#ensureDevice().catch(() =>
        this.#update({ state: "error", error: "麦克风恢复失败，请按键重试。" }),
      );
    }
  }

  start(): Promise<void> {
    if (this.#disposed || this.#sessionChanging || !this.#settings.enabled)
      return Promise.resolve();
    if (this.#capturing) return this.#capturing.setup;
    const turn: CaptureTurn = {
      token: ++this.#token,
      requestId: createId("req"),
      taskId: createId("task"),
      pressedAt: performance.now(),
      firstSample: false,
      sequence: 0,
      buffered: [],
      ready: false,
      capture: Promise.resolve(),
      setup: Promise.resolve(),
      send: Promise.resolve(),
    };
    this.#capturing = turn;
    this.#turns.set(turn.token, turn);
    // 就绪路径在按键回调内直接开门。只等待本地旧尾音，不等待云端或 Host。
    if (this.#deviceReady && !this.#captureClosing) {
      try {
        this.#recorder!.begin(turn.token);
      } catch (error) {
        turn.capture = Promise.reject(error);
      }
      // 已预热的图在休眠后可能 suspended；立即开门，同时恢复其时钟。
      if (!this.#disposed) void this.#ensureDevice().catch(() => {});
    } else {
      turn.capture = this.#captureTail.then(async () => {
        await this.#ensureDevice();
        if (turn.releasedAt !== undefined || this.#disposed) return;
        await this.#recorder!.start(this.#stream!, turn.token);
      });
    }
    void turn.capture.catch(() => {});
    this.#player.stop();
    this.#acceptMessages = false;
    turn.setup = this.#rpcTail.then(() => this.#startRecording(turn));
    this.#rpcTail = turn.setup.catch(() => {});
    return turn.setup;
  }

  /** 只跳过采集/STT；仍由本窗口唯一播放器消费同一 Worker 闭环事件。 */
  submitText(text: string): Promise<void> {
    if (!text.trim() || text.length > TEXT_INPUT_MAX_LENGTH)
      return Promise.reject(new Error("消息不能为空或过长"));
    if (this.#disposed) return Promise.reject(new Error("助手已关闭"));
    if (this.#sessionChanging) return Promise.reject(new Error("会话正在切换"));
    // 立即阻断旧播报；关闭录音门控，但不把正在说的话再提交成额外一轮。
    if (this.#capturing) this.#capturing.failed = true;
    void this.stop();
    const token = ++this.#token;
    this.#player.stop();
    this.#acceptMessages = false;
    const requestId = createId("req");
    const taskId = createId("task");
    const submit = this.#rpcTail.then(async () => {
      if (this.#disposed || token !== this.#token) throw new Error("文字提交已被新输入取消");
      try {
        await this.#prepareTurn(requestId, taskId, token);
        if (token !== this.#token) throw new Error("文字提交已被新输入取消");
        const cwd = await invoke<string>("get_agent_workspace");
        if (this.#disposed || token !== this.#token) throw new Error("文字提交已被新输入取消");
        this.#update({
          state: "thinking",
          transcript: text.trim(),
          assistantText: "",
          report: "",
          error: undefined,
        });
        await this.#send(
          "voice.text.submit",
          {
            sessionId: this.#sessionId,
            taskId,
            cwd,
            text: text.trim(),
            action: "prompt",
          },
          requestId,
        );
      } catch (error) {
        if (token === this.#token)
          this.#update({ state: "error", error: "文字消息提交失败，请重试。" });
        throw error;
      }
    });
    this.#rpcTail = submit.catch(() => {});
    return submit;
  }

  /** 与输入共用 RPC 队列；先关闭本地门控，Host 提交选择后才允许下一轮输入。 */
  switchSession(sessionId: string, id: string): Promise<void> {
    if (this.#disposed || this.#sessionChanging) return Promise.reject(new Error("无法切换会话"));
    this.#sessionChanging = true;
    for (const turn of this.#turns.values()) turn.failed = true;
    void this.stop();
    ++this.#token;
    this.#acceptMessages = false;
    this.#player.stop();
    const change = this.#rpcTail
      .then(async () => {
        if (this.#disposed) throw new Error("助手已关闭");
        if (this.#taskId) await this.interrupt("pause");
        this.#sessionId = await invoke<string>("activate_client_session", { sessionId, id });
        this.#requestId = undefined;
        this.#taskId = undefined;
        this.#pendingSnapshot = undefined;
        this.#sentences.clear();
        this.#summary = "";
        this.#update({
          state: "idle",
          transcript: "",
          assistantText: "",
          report: "",
          error: undefined,
        });
      })
      .finally(() => {
        this.#sessionChanging = false;
      });
    this.#rpcTail = change.catch(() => {});
    return change;
  }

  /** 音频与文字共用轮次握手，确保会话、播放和取消状态不会分裂。 */
  async #prepareTurn(
    requestId: string,
    taskId: string,
    token: number,
    releasedAt?: number,
  ): Promise<void> {
    if (this.#disposed) throw new Error("助手已关闭");
    await this.#player.unlock();
    if (this.#disposed) throw new Error("助手已关闭");
    if (
      ["transcribing", "thinking", "speaking", "listening"].includes(this.#snapshot.state) &&
      this.#taskId
    ) {
      await this.interrupt("pause");
    }
    this.#player.stop();
    this.#requestId = requestId;
    this.#taskId = taskId;
    this.#sentences.clear();
    this.#generated = false;
    this.#playbackFailed = false;
    this.#summary = "";
    this.#releasedAt = releasedAt;
    this.#firstPlayback = false;
    this.#firstText = false;
    this.#firstModel = false;
    this.#firstTts = false;
    this.#lastPlaybackDiagnostic = undefined;
    this.#acceptMessages = token === this.#token;
    this.#sessionId = await invoke<string>("start_voice_conversation", {
      requestId,
      sessionId: this.#sessionId,
      taskId,
    });
    if (this.#disposed) throw new Error("助手已关闭");
  }

  async #startRecording(turn: CaptureTurn): Promise<void> {
    try {
      if (this.#disposed || turn.failed) {
        turn.failed = true;
        return;
      }
      // 页面刷新不能重建 Worker 的 Pi 会话；以 Host 返回的身份为准，
      // 并在音频/快照发送前完成握手，避免 STT 后才发现会话不一致。
      await this.#prepareTurn(turn.requestId, turn.taskId, turn.token, turn.releasedAt);
      if (this.#disposed || turn.failed) {
        turn.failed = true;
        return;
      }
      // 授权可能被拒绝；先建立 Host 快照，错误才会送到有文字的客户端。
      this.#update({
        state: "listening",
        transcript: "",
        assistantText: "",
        report: "",
        error: undefined,
      });
      turn.send = this.#send("voice.turn.start", {
        sessionId: this.#sessionId,
        taskId: this.#taskId,
        cwd: await invoke<string>("get_agent_workspace"),
        mimeType: "audio/pcm",
        sampleRateHz: 16_000,
        // pause 已等待当前 Pi 轮次停止；后续语音应在同一 Session 上启动新
        // prompt。Pi 的 followUp 只为正在运行的循环排队，空闲时不会自行启动。
        action: "prompt",
      });
      void turn.send.catch(() => {});
      await turn.capture;
      turn.ready = true;
      for (const data of turn.buffered) this.#appendAudio(turn, data);
      turn.buffered = [];
      await turn.send;
      this.#update({
        state: "listening",
        transcript: "",
        assistantText: "",
        report: "",
        error: undefined,
      });
    } catch (error) {
      turn.failed = true;
      await turn.capture.catch(() => {});
      if (this.#capturing === turn) {
        this.#capturing = undefined;
        await this.#recorder?.stop();
      }
      turn.ready = false;
      turn.buffered = [];
      this.#turns.delete(turn.token);
      if (!this.#disposed && this.#requestId === turn.requestId) {
        if (this.#taskId) await this.interrupt("cancel").catch(() => {});
        if (turn.token === this.#token)
          this.#update({
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
  }

  #appendAudio(turn: CaptureTurn, data: Uint8Array): void {
    const sequence = turn.sequence++;
    turn.send = turn.send.then(() => {
      if (sequence === 0)
        this.#logTiming(
          "client.press_to_first_send",
          performance.now() - turn.pressedAt,
          turn.requestId,
        );
      return this.#send(
        "voice.audio.append",
        { sequence, audioBase64: toBase64(data) },
        turn.requestId,
      );
    });
    // IPC 失败仍由 start/stop 的 await 处理；不要在持续录音时提前产生未处理拒绝。
    void turn.send.catch(() => {});
  }

  async stop(): Promise<void> {
    const turn = this.#capturing;
    if (!turn) return this.#lastStop;
    this.#capturing = undefined;
    turn.releasedAt = performance.now();
    this.#captureClosing++;
    const flush = turn.capture.then(() => this.#recorder?.stop());
    this.#captureTail = flush
      .catch(() => {})
      .then(() => {
        this.#captureClosing--;
      });
    turn.stop = (async () => {
      try {
        await flush;
        await turn.setup;
        await turn.send;
        if (turn.failed || this.#disposed) {
          if (!this.#disposed && this.#requestId === turn.requestId)
            await this.interrupt("cancel").catch(() => {});
          return;
        }
        if (this.#requestId !== turn.requestId) return;
        this.#releasedAt = turn.releasedAt;
        if (turn.sequence === 0) {
          await this.interrupt("cancel").catch(() => {});
          this.#update({ state: "error", error: "未采集到声音，请检查麦克风权限或设备就绪状态。" });
          return;
        }
        if (turn.silent) {
          await this.interrupt("cancel").catch(() => {});
          this.#update({ state: "error", error: "只采集到静音，请检查输入设备和麦克风音量。" });
          return;
        }
        await this.#send("voice.turn.commit", { lastSequence: turn.sequence - 1 }, turn.requestId);
        if (this.#snapshot.state === "listening") this.#update({ state: "transcribing" });
      } catch {
        if (this.#requestId === turn.requestId) {
          await this.interrupt("cancel").catch(() => {});
          this.#update({ state: "error", error: "录音提交失败，请重新按键录音。" });
        }
      } finally {
        this.#turns.delete(turn.token);
        if (!this.#settings.prewarm && !this.#capturing && !this.#captureClosing)
          this.#releaseDevice();
      }
    })();
    this.#rpcTail = turn.stop.catch(() => {});
    this.#lastStop = turn.stop;
    return turn.stop;
  }

  async interrupt(mode: "pause" | "cancel"): Promise<void> {
    if (!this.#taskId) {
      return;
    }
    this.#player.stop();
    this.#acceptMessages = false;
    this.#update({ state: "interrupted" });
    await this.#send("voice.interrupt", {
      taskId: this.#taskId,
      mode,
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#releaseDevice();
    void this.#recorder?.dispose();
    this.#player.dispose();
    this.#unlisten.forEach((unlisten) => unlisten());
    this.#unlisten = [];
  }

  async #send(
    kind: string,
    payload: Record<string, unknown>,
    requestId = this.#requestId,
  ): Promise<void> {
    if (this.#disposed) throw new Error("voice client disposed");
    if (!requestId) {
      throw new Error("voice turn has not started");
    }
    await invoke("send_worker_request", {
      envelope: {
        direction: "request",
        protocolVersion: 1,
        requestId,
        kind,
        payload,
      },
    });
  }

  #onWorkerMessage(message: WorkerEnvelope): void {
    try {
      assertValidEnvelope(message);
      if (message.direction === "event" && message.kind.startsWith("voice.")) {
        parseVoiceEvent(message);
        // `parseVoiceEvent` 已完成字段级校验；这里仍按边界对象读取可选身份，
        // 因为 transcript/state/error 等合法事件并不携带 sessionId/taskId。
        const payload = message.payload as Record<string, unknown>;
        if (
          (typeof payload.sessionId === "string" && payload.sessionId !== this.#sessionId) ||
          (typeof payload.taskId === "string" && payload.taskId !== this.#taskId)
        ) {
          return;
        }
      }
    } catch {
      return;
    }
    if (message.requestId !== this.#requestId || !this.#acceptMessages) {
      return;
    }
    if (message.direction === "error") {
      this.#player.stop();
      this.#update({
        state: "error",
        error: String(message.payload.message ?? "语音请求失败"),
      });
      return;
    }
    if (message.direction !== "event") {
      return;
    }
    if (message.kind === "research.timing") {
      const { stage, durationMs } = message.payload;
      if (
        typeof stage === "string" &&
        stage.length <= 128 &&
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs >= 0
      ) {
        this.#logTiming(stage, durationMs);
        if (
          stage === "speech.first_sentence_ready" &&
          !this.#firstModel &&
          this.#releasedAt !== undefined
        ) {
          this.#firstModel = true;
          this.#logTiming("client.release_to_first_segment", performance.now() - this.#releasedAt);
        }
      }
    } else if (message.kind === "voice.state") {
      const state = message.payload.state;
      if (
        [
          "idle",
          "listening",
          "transcribing",
          "thinking",
          "speaking",
          "interrupted",
          "error",
        ].includes(String(state))
      ) {
        if (this.#snapshot.error && state !== "error") return;
        if (state !== "idle" || !this.#player.busy)
          this.#update({ state: state as VoiceClientState });
      }
    } else if (
      message.kind === "voice.transcript.partial" ||
      message.kind === "voice.transcript.final"
    ) {
      this.#update({ transcript: String(message.payload.text ?? "") });
      if (message.kind === "voice.transcript.final" && this.#releasedAt !== undefined) {
        this.#logTiming("client.release_to_final_transcript", performance.now() - this.#releasedAt);
      }
    } else if (message.kind === "voice.sentence") {
      const { sentenceId, text, purpose } = message.payload;
      if (
        typeof sentenceId === "string" &&
        typeof text === "string" &&
        text.length <= 8192 &&
        ["answer", "stage", "confirmation"].includes(String(purpose))
      ) {
        this.#sentences.set(sentenceId, { text, purpose: String(purpose), revealed: "" });
      }
    } else if (message.kind === "voice.timestamps") {
      const sentence = this.#sentences.get(String(message.payload.sentenceId));
      if (sentence) sentence.words = validateWords(message.payload.words, sentence.text);
    } else if (message.kind === "voice.answer") {
      if (
        typeof message.payload.summary !== "string" ||
        message.payload.summary.length > 128_000 ||
        typeof message.payload.report !== "string" ||
        message.payload.report.length > 512_000
      )
        return;
      this.#summary = message.payload.summary;
      this.#update({ report: message.payload.report });
      if (this.#playbackFailed && typeof message.payload.summary === "string")
        this.#update({ assistantText: message.payload.summary });
    } else if (message.kind === "voice.turn.completed") {
      this.#generated = true;
      if (!this.#player.busy) this.#update({ state: this.#playbackFailed ? "error" : "idle" });
    } else if (message.kind === "voice.audio.chunk") {
      if (this.#playbackFailed) return;
      if (
        typeof message.payload.sentenceId !== "string" ||
        !this.#sentences.has(message.payload.sentenceId) ||
        !["audio/mpeg", VOICE_PCM_MIME].includes(String(message.payload.mimeType)) ||
        typeof message.payload.audioBase64 !== "string" ||
        message.payload.audioBase64.length > 2_000_000 ||
        message.payload.audioBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(message.payload.audioBase64) ||
        typeof message.payload.first !== "boolean"
      )
        return;
      this.#player.append(
        String(message.payload.sentenceId),
        String(message.payload.mimeType),
        String(message.payload.audioBase64),
        Boolean(message.payload.first),
      );
      if (message.payload.first)
        this.#diagnosePlayback("audio_received", {
          bytes: atob(message.payload.audioBase64).length,
        });
      if (
        !this.#firstTts &&
        message.payload.first &&
        this.#sentences.get(message.payload.sentenceId)?.purpose === "answer" &&
        this.#releasedAt !== undefined
      ) {
        this.#firstTts = true;
        this.#logTiming("client.release_to_tts_ready", performance.now() - this.#releasedAt);
      }
    } else if (message.kind === "voice.audio.completed") {
      this.#player.complete(String(message.payload.sentenceId));
    } else if (message.kind === "voice.audio.stop") {
      this.#player.stop();
    } else if (message.kind === "voice.error") {
      if (message.payload.code === "cloud_tts_failed") {
        this.#playbackFailed = true;
        this.#player.stop();
      }
      this.#update({
        state: "error",
        error: String(message.payload.message ?? "语音处理失败"),
        ...(this.#playbackFailed ? { assistantText: this.#summary } : {}),
      });
    }
  }

  #update(patch: Partial<VoiceClientSnapshot>, playback?: PlaybackEvent): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach((listener) => listener(this.#snapshot));
    this.#publish(playback);
  }

  #onPlayback(event: PlaybackEvent): void {
    if (!this.#acceptMessages || (this.#playbackFailed && event.state !== "failed")) return;
    const diagnostic = `${event.sentenceId}:${event.state}`;
    if (diagnostic !== this.#lastPlaybackDiagnostic) {
      this.#lastPlaybackDiagnostic = diagnostic;
      this.#diagnosePlayback(event.state, { positionMs: event.positionMs });
    }
    const sentence = this.#sentences.get(event.sentenceId);
    if (event.state === "failed") {
      this.#playbackFailed = true;
      this.#update(
        { state: "error", assistantText: this.#summary, error: "语音播放失败，文字回答仍可查看。" },
        event,
      );
      return;
    }
    if (sentence?.purpose === "answer" && event.state === "playing") {
      if (!this.#firstPlayback && this.#releasedAt !== undefined) {
        this.#firstPlayback = true;
        this.#logTiming(
          "client.release_to_first_answer_playback",
          performance.now() - this.#releasedAt,
        );
      }
      const revealed = spokenPrefix(sentence.text, sentence.words, event.positionMs);
      // 时间戳晚到时不能撤回已显示的整句；缓冲/暂停不进入这个分支。
      if (revealed.length > sentence.revealed.length) sentence.revealed = revealed;
      if (!this.#firstText && sentence.revealed && this.#releasedAt !== undefined) {
        this.#firstText = true;
        // 这是助手准备好同步文字的时间，不冒充另一 WebView 已完成绘制。
        this.#logTiming("client.release_to_first_text_ready", performance.now() - this.#releasedAt);
      }
      this.#update(
        {
          state: "speaking",
          assistantText: [...this.#sentences.values()]
            .filter((entry) => entry.purpose === "answer")
            .map((entry) => entry.revealed)
            .join(""),
        },
        event,
      );
    } else if (event.state === "playing") this.#update({ state: "speaking" }, event);
    else if (event.state === "ended") {
      if (sentence?.purpose === "answer") sentence.revealed = sentence.text;
      this.#update(
        {
          assistantText: [...this.#sentences.values()]
            .filter((entry) => entry.purpose === "answer")
            .map((entry) => entry.revealed)
            .join(""),
          ...(this.#generated && !this.#player.busy
            ? { state: this.#playbackFailed ? "error" : "idle" }
            : {}),
        },
        event,
      );
    } else this.#publish(event);
  }

  /** 只记录状态转换与首包，不逐帧落盘；声音是否实际可听仍需真人确认。 */
  #diagnosePlayback(stage: string, metrics: Record<string, number>): void {
    if (!this.#requestId) return;
    const context = this.#player.audioContext;
    void invoke("record_voice_playback", {
      requestId: this.#requestId,
      stage,
      metrics: {
        ...metrics,
        contextTime: context?.currentTime ?? 0,
        contextRunning: context?.state === "running" ? 1 : 0,
        level: this.audioLevel.current,
      },
    }).catch(() => {});
  }

  /** 只输出轮次 ID 和数值耗时，不记录转写、音频、报告或 Provider 凭证。 */
  #logTiming(stage: string, durationMs: number, requestId = this.#requestId): void {
    console.info("语音阶段耗时", {
      requestId,
      stage,
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    if (requestId && !this.#disposed)
      void invoke("record_voice_timing", {
        requestId,
        stage,
        durationMs: Math.max(0, Math.round(durationMs)),
      }).catch(() => {});
  }

  #publish(playback?: PlaybackEvent): void {
    if (!this.#requestId) return;
    const now = performance.now();
    if (playback?.state === "playing" && now - this.#lastPublish < 80) return;
    this.#lastPublish = now;
    const snapshot = {
      requestId: this.#requestId,
      sessionId: this.#sessionId,
      taskId: this.#taskId,
      ...this.#snapshot,
      playback,
    };
    // IPC 慢于动画帧时只保留最新进度，禁止无限堆积旧快照；最终事件也不会丢失。
    this.#pendingSnapshot = snapshot;
    if (!this.#publishing) void this.#drainSnapshots();
  }

  async #drainSnapshots(): Promise<void> {
    this.#publishing = true;
    try {
      while (this.#pendingSnapshot) {
        const snapshot = this.#pendingSnapshot;
        this.#pendingSnapshot = undefined;
        try {
          await invoke("publish_voice_snapshot", { snapshot });
        } catch {
          /* 轮次切换后 Host 会拒绝迟到的旧快照。 */
        }
      }
    } finally {
      this.#publishing = false;
    }
  }
}
