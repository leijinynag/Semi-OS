import { VOICE_PCM_MIME } from "@semi-os/protocol";
import { PcmStream } from "./pcm-stream.ts";
import { pcmEnvelope, envelopeLevel, smoothLevel, type PcmEnvelope } from "./pcm-envelope.ts";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** 标准 WAV 封装让 PCM 可直接走媒体输出，不把媒体节点再接回 WebAudio。 */
export function pcmWave(chunks: Uint8Array[]): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!length || length % 2) throw new Error("invalid PCM sentence");
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const tag = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  tag(0, "RIFF"); view.setUint32(4, 36 + length, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 22_050, true); view.setUint32(28, 44_100, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, length, true);
  return new Blob([header, ...chunks.map((chunk) => chunk.slice().buffer)], { type: "audio/wav" });
}

interface QueuedSentence {
  sentenceId: string;
  mimeType: string;
  chunks: Uint8Array[];
  completed: boolean;
}

interface ActiveSentence extends QueuedSentence {
  audio?: HTMLAudioElement;
  pcm?: PcmStream;
  mediaSource?: MediaSource;
  sourceBuffer?: SourceBuffer;
  objectUrl?: string;
  playing: boolean;
  source?: MediaElementAudioSourceNode;
  envelope?: PcmEnvelope;
}

export interface PlaybackEvent {
  sentenceId: string;
  state: "playing" | "buffering" | "paused" | "ended" | "failed";
  positionMs: number;
}
/**
 * 以 sentenceId 为播放边界，把 Worker 返回的音频按句排队。
 *
 * Worker 串行完成的是 TTS 生成而不是用户侧播放，因此新句到达不能停止上一句；
 * 正常切句只由 audio ended 驱动，`stop` 仅用于用户打断并清空整个队列。
 */
export class VoicePlayer {
  readonly audioLevel = { current: 0 };
  readonly #onPlayback: (event: PlaybackEvent) => void;
  #active?: ActiveSentence;
  #queued: QueuedSentence[] = [];
  #context?: AudioContext;
  #analyser?: AnalyserNode;
  #frame?: number;
  #recovering?: ActiveSentence;
  #recoveryTimer?: ReturnType<typeof setTimeout>;
  readonly #mediaOutput: boolean;

  constructor(onPlayback: (event: PlaybackEvent) => void = () => {}, options: { mediaOutput?: boolean } = {}) {
    this.#onPlayback = onPlayback;
    this.#mediaOutput = options.mediaOutput ?? false;
  }

  get busy(): boolean { return Boolean(this.#active || this.#queued.length); }

  /** 播放专用上下文；不挂接麦克风节点，不受录音器销毁影响。 */
  get audioContext(): AudioContext | undefined {
    if (typeof AudioContext === "undefined") return undefined;
    return this.#context ??= new AudioContext();
  }

  /** 由真实用户按键启动音频上下文，避免自动播放限制；同一 WebView 只建一次。 */
  async unlock(): Promise<void> {
    await this.audioContext?.resume();
  }

  append(
    sentenceId: string,
    mimeType: string,
    audioBase64: string,
    first: boolean,
  ): void {
    let sentence = this.#findSentence(sentenceId);
    if (!sentence) {
      if (!first) {
        return;
      }
      sentence = { sentenceId, mimeType, chunks: [], completed: false };
      if (this.#active) {
        this.#queued.push(sentence);
      } else {
        this.#activate(sentence);
        sentence = this.#active;
      }
    } else if (sentence.mimeType !== mimeType) {
      return;
    }

    sentence?.chunks.push(decodeBase64(audioBase64));
    if (sentence === this.#active) {
      this.#flush();
    }
  }

  complete(sentenceId: string): void {
    const sentence = this.#findSentence(sentenceId);
    if (!sentence) {
      return;
    }
    sentence.completed = true;
    const active = this.#active;
    if (!active || sentence !== active) {
      return;
    }
    if (active.pcm) {
      this.#flush();
      return;
    }
    if (!active.mediaSource) {
      const parts = active.chunks.map((chunk) => chunk.slice().buffer);
      let blob: Blob;
      try {
        if (active.mimeType === VOICE_PCM_MIME) active.envelope = pcmEnvelope(active.chunks);
        blob = active.mimeType === VOICE_PCM_MIME
          ? pcmWave(active.chunks)
          : new Blob(parts, { type: active.mimeType });
      } catch { this.#fail(active); return; }
      active.objectUrl = URL.createObjectURL(blob);
      active.audio!.src = active.objectUrl;
      void active.audio!.play().catch(() => this.#fail(active));
      return;
    }
    this.#flush();
  }

  stop(): void {
    this.#clearRecovery();
    const active = this.#active;
    this.#active = undefined;
    this.#queued = [];
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.audioLevel.current = 0;
    if (active) {
      this.#publish(active, "paused");
      active.audio?.pause();
      this.#revoke(active);
    }
  }

  dispose(): void {
    this.stop();
    void this.#context?.close();
    this.#context = undefined;
  }

  #flush(): void {
    const active = this.#active;
    if (active?.pcm) {
      for (const chunk of active.chunks.splice(0)) active.pcm.append(chunk);
      if (active.completed) active.pcm.complete();
      return;
    }
    if (
      !active?.sourceBuffer ||
      active.sourceBuffer.updating ||
      !active.mediaSource ||
      active.mediaSource.readyState !== "open"
    ) {
      return;
    }
    const next = active.chunks.shift();
    if (next) {
      try { active.sourceBuffer.appendBuffer(next.slice().buffer); }
      catch { this.#fail(active); }
      return;
    }
    if (active.completed) {
      try { active.mediaSource.endOfStream(); }
      catch { this.#fail(active); }
    }
  }

  #findSentence(sentenceId: string): QueuedSentence | ActiveSentence | undefined {
    if (this.#active?.sentenceId === sentenceId) {
      return this.#active;
    }
    return this.#queued.find((sentence) => sentence.sentenceId === sentenceId);
  }

  #activate(sentence: QueuedSentence): void {
    const active: ActiveSentence = {
      ...sentence,
      playing: false,
    };
    this.#active = active;
    if (active.mimeType === VOICE_PCM_MIME && !this.#mediaOutput) {
      if (!this.#context) { this.#fail(active); return; }
      try {
        active.pcm = new PcmStream(this.#context, this.audioLevel, (event) => {
          if (this.#active !== active) return;
          if (event.state === "ended") this.#finish(active);
          else if (event.state === "failed") this.#fail(active);
          else {
            this.#onPlayback({ sentenceId: active.sentenceId, ...event });
            if (event.state === "paused") this.#recoverContext(active);
          }
        });
        this.#flush();
        this.#recoverContext(active);
      } catch { this.#fail(active); }
      return;
    }
    const audio = new Audio();
    active.audio = audio;
    // 媒体兼容路径必须直接输出。createMediaElementSource 会把输出重新
    // 路由进可能无声的 WebAudio 图，失去隔离验证的意义。
    audio.volume = 1;
    audio.muted = false;
    if (this.#context && !this.#mediaOutput) {
      try {
        this.#analyser ??= this.#context.createAnalyser();
        this.#analyser.fftSize = 256;
        active.source = this.#context.createMediaElementSource(audio);
        active.source.connect(this.#analyser);
        this.#analyser.connect(this.#context.destination);
      } catch { /* 音量分析失败不影响音频本身和文字同步。 */ }
    }
    audio.addEventListener("playing", () => {
      if (this.#active !== active) return;
      active.playing = true;
      this.#publish(active, "playing");
      this.#sample(active);
    });
    for (const event of ["waiting", "pause"] as const) {
      audio.addEventListener(event, () => {
        if (this.#active !== active) return;
        active.playing = false;
        this.audioLevel.current = 0;
        this.#publish(active, event === "waiting" ? "buffering" : "paused");
      });
    }
    audio.addEventListener("timeupdate", () => {
      if (active.playing && this.#active === active) this.#publish(active, "playing");
    });
    audio.addEventListener("error", () => this.#fail(active));
    audio.addEventListener("ended", () => this.#finish(active), {
      once: true,
    });
    if (
      typeof MediaSource !== "undefined" &&
      active.mimeType !== VOICE_PCM_MIME &&
      MediaSource.isTypeSupported(active.mimeType)
    ) {
      active.mediaSource = new MediaSource();
      active.objectUrl = URL.createObjectURL(active.mediaSource);
      audio.src = active.objectUrl;
      active.mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (
            this.#active !== active ||
            active.mediaSource?.readyState !== "open"
          ) {
            return;
          }
          try { active.sourceBuffer = active.mediaSource.addSourceBuffer(active.mimeType); }
          catch { this.#fail(active); return; }
          active.sourceBuffer.addEventListener("updateend", () => this.#flush());
          this.#flush();
          void audio.play().catch(() => this.#fail(active));
        },
        { once: true },
      );
    } else if (active.completed) {
      this.complete(active.sentenceId);
    }
  }

  #finish(sentence: ActiveSentence): void {
    if (this.#active !== sentence) {
      return;
    }
    this.#clearRecovery();
    this.#revoke(sentence);
    this.#active = undefined;
    this.audioLevel.current = 0;
    this.#publish(sentence, "ended");
    const next = this.#queued.shift();
    if (next) {
      this.#activate(next);
    }
  }

  #revoke(sentence: ActiveSentence): void {
    sentence.pcm?.stop();
    sentence.source?.disconnect();
    if (sentence.objectUrl) {
      URL.revokeObjectURL(sentence.objectUrl);
    }
  }

  #fail(sentence: ActiveSentence): void {
    if (this.#active !== sentence) return;
    // 单句失败不能留下等待 completed 的空队列，亦不能假装 ended。
    this.stop();
    this.#publish(sentence, "failed");
  }

  /**
   * 按键时的 resume 不能保证松键后上下文仍在运行。暂停时恢复原排程，
   * 不重播音频；恢复超时必须报错，不能永远显示暂停。回调绑定句子身份，
   * 用户打断后即使 resume 迟到也不能影响新轮次。
   */
  #recoverContext(sentence: ActiveSentence): void {
    const context = this.#context;
    if (!context || context.state === "running" || this.#recovering === sentence) return;
    this.#recovering = sentence;
    this.#recoveryTimer = setTimeout(() => {
      if (this.#recovering === sentence && this.#active === sentence) {
        if (context.state === "running") this.#clearRecovery();
        else this.#fail(sentence);
      }
    }, 3000);
    void context.resume().then(() => {
      if (this.#recovering === sentence && context.state === "running") this.#clearRecovery();
    }, () => {
      if (this.#recovering === sentence && this.#active === sentence) this.#fail(sentence);
    });
  }

  #clearRecovery(): void {
    if (this.#recoveryTimer !== undefined) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    this.#recovering = undefined;
  }

  #publish(sentence: ActiveSentence, state: PlaybackEvent["state"]): void {
    this.#onPlayback({ sentenceId: sentence.sentenceId, state,
      positionMs: sentence.pcm?.positionMs ?? Math.max(0, Math.round((sentence.audio?.currentTime || 0) * 1000)) });
  }

  #sample(sentence: ActiveSentence): void {
    if (typeof requestAnimationFrame === "undefined") return;
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    const samples = new Float32Array(this.#analyser?.fftSize ?? 256);
    let previousTime: number | undefined;
    const tick = (now: number) => {
      if (this.#active !== sentence || !sentence.playing) { this.#frame = undefined; return; }
      this.#analyser?.getFloatTimeDomainData(samples);
      const target = sentence.envelope
        ? envelopeLevel(sentence.envelope, sentence.audio?.currentTime ?? 0)
        : Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 4);
      this.audioLevel.current = smoothLevel(this.audioLevel.current, target, previousTime === undefined ? 1 / 60 : (now - previousTime) / 1000);
      previousTime = now;
      this.#publish(sentence, "playing");
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }
}
