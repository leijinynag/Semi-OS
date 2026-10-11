export interface PcmPlayback {
  state: "playing" | "buffering" | "paused" | "ended" | "failed";
  positionMs: number;
}

interface Segment {
  start: number;
  end: number;
  offset: number;
}

/**
 * 单句 PCM16 分片播放器，不持有会话或 TTS 状态。
 *
 * AudioContext 时钟才是播放进度；网络欠载的空隙不能累计到字词时间轴中。
 * 结束输入与结束播放分开：最后一个已排程分片播完后才能发 ended。
 */
export class PcmStream {
  readonly #context: AudioContext;
  readonly #onPlayback: (event: PcmPlayback) => void;
  readonly #level: { current: number };
  readonly #analyser: AnalyserNode;
  readonly #samples: Float32Array<ArrayBuffer>;
  readonly #sources = new Set<AudioBufferSourceNode>();
  #segments: Segment[] = [];
  #tail?: number;
  #scheduledTail = 0;
  #duration = 0;
  #position = 0;
  #completed = false;
  #stopped = false;
  #state?: PcmPlayback["state"];
  #timer?: ReturnType<typeof setInterval>;
  #lastClock: number;
  #clockAdvancedAt = performance.now();

  constructor(context: AudioContext, level: { current: number }, onPlayback: (event: PcmPlayback) => void) {
    this.#context = context;
    this.#lastClock = context.currentTime;
    this.#level = level;
    this.#onPlayback = onPlayback;
    this.#analyser = context.createAnalyser();
    this.#analyser.fftSize = 256;
    // 显式使用 ArrayBuffer，兼容当前 TypeScript DOM 定义对 AudioNode
    // 采样缓冲区的泛型约束，避免把 SharedArrayBuffer 误传给 Web Audio。
    this.#samples = new Float32Array(new ArrayBuffer(this.#analyser.fftSize * 4));
    this.#analyser.connect(context.destination);
    this.#timer = setInterval(() => this.#tick(), 20);
  }

  get positionMs(): number { return Math.round(this.#position * 1000); }

  append(bytes: Uint8Array): void {
    if (this.#stopped || this.#completed) return;
    // WebSocket 可以在样本的两个字节之间分帧，保留尾字节到下个分片。
    const merged = new Uint8Array(bytes.length + (this.#tail === undefined ? 0 : 1));
    if (this.#tail !== undefined) merged[0] = this.#tail;
    merged.set(bytes, this.#tail === undefined ? 0 : 1);
    this.#tail = merged.length % 2 ? merged[merged.length - 1] : undefined;
    const count = Math.floor(merged.length / 2);
    if (!count) return;
    try {
      const buffer = this.#context.createBuffer(1, count, 22_050);
      const channel = buffer.getChannelData(0);
      const data = new DataView(merged.buffer);
      for (let index = 0; index < count; index++) channel[index] = data.getInt16(index * 2, true) / 32768;
      // 播放进度会清理 segment；排程尾点单独维护，让排程与进度清理解耦。
      // PCM 分片是连续样本，不照搬压缩音频的 cross-fade，避免重复播放音节。
      const start = Math.max(this.#context.currentTime + 0.02, this.#scheduledTail);
      this.#scheduledTail = start + buffer.duration;
      const source = this.#context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.#analyser);
      this.#sources.add(source);
      source.onended = () => {
        source.disconnect();
        this.#sources.delete(source);
        this.#tick();
      };
      this.#segments.push({ start, end: start + buffer.duration, offset: this.#duration });
      this.#duration += buffer.duration;
      source.start(start);
    } catch { this.#fail(); }
  }

  complete(): void {
    if (this.#stopped) return;
    this.#completed = true;
    if (this.#tail !== undefined || this.#duration === 0) { this.#fail(); return; }
    this.#tick();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const source of this.#sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.#sources.clear();
    this.#analyser.disconnect();
    this.#level.current = 0;
    this.#scheduledTail = 0;
  }

  #tick(): void {
    if (this.#stopped) return;
    const now = this.#context.currentTime;
    // WebKit 可能在 running 状态下停止音频时钟。不能把无限 buffering
    // 当作正常播放，也不能据墙钟推进字幕；失败后交由客户端显示完整文字。
    if (now !== this.#lastClock || this.#sources.size === 0 ||
        this.#context.state !== "running") {
      this.#lastClock = now;
      this.#clockAdvancedAt = performance.now();
    } else if (performance.now() - this.#clockAdvancedAt >= 3000) {
      this.#fail();
      return;
    }
    while (this.#segments[0] && this.#segments[0].end <= now) {
      const segment = this.#segments.shift()!;
      this.#position = segment.offset + segment.end - segment.start;
    }
    const segment = this.#segments[0];
    if (this.#context.state !== "running") { this.#emit("paused"); return; }
    if (segment && now >= segment.start) {
      this.#position = segment.offset + Math.min(now - segment.start, segment.end - segment.start);
      this.#analyser.getFloatTimeDomainData(this.#samples);
      this.#level.current = Math.min(1, Math.sqrt(this.#samples.reduce((sum, value) => sum + value * value, 0) / this.#samples.length) * 4);
      this.#emit("playing");
    } else if (this.#completed && !segment) {
      this.stop();
      this.#emit("ended");
    } else {
      this.#level.current = 0;
      this.#emit("buffering");
    }
  }

  #emit(state: PcmPlayback["state"]): void {
    if (state !== "playing" && state === this.#state) return;
    this.#state = state;
    this.#onPlayback({ state, positionMs: this.positionMs });
  }

  #fail(): void {
    this.stop();
    this.#emit("failed");
  }
}
