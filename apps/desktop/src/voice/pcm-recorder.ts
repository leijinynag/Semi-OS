export interface PcmRecorderOptions {
  /** 借用播放器的上下文，停止录音或销毁录音器都不得关闭它。 */
  audioContext?: AudioContext;
  targetSampleRate?: number;
  chunkDurationMs?: number;
  onChunk(data: Uint8Array, token: number): void;
  onFirstSample?(token: number): void;
  onDiagnostics?(value: { sampleRateHz: number; rms: number; peak: number; clippedSamples: number; silenceRatio: number }, token: number): void;
}

/** 积分重采样跨分片保留小数边界；44.1 kHz 输入不再每块丢失尾部采样。 */
export class StreamingResampler {
  readonly #ratio: number;
  #weight = 0;
  #sum = 0;
  constructor(sourceRate: number, targetRate: number) {
    if (sourceRate < targetRate || targetRate <= 0) throw new Error("invalid resampling rate");
    this.#ratio = sourceRate / targetRate;
  }
  push(input: Float32Array): Float32Array {
    const output: number[] = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const amount = Math.min(remaining, this.#ratio - this.#weight);
        this.#sum += sample * amount;
        this.#weight += amount;
        remaining -= amount;
        if (this.#weight >= this.#ratio - 1e-8) {
          output.push(this.#sum / this.#ratio);
          this.#weight = 0;
          this.#sum = 0;
        }
      }
    }
    return Float32Array.from(output);
  }
  flush(): Float32Array {
    const output = this.#weight ? Float32Array.of(this.#sum / this.#weight) : new Float32Array();
    this.#weight = 0; this.#sum = 0;
    return output;
  }
}

export function resampleMono(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) {
    return input;
  }
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex] ?? 0;
    }
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

export function floatToPcm16(input: Float32Array): Uint8Array {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  input.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      index * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  });
  return bytes;
}

/**
 * 将 WebView 麦克风输入转换为 DashScope 要求的 16 kHz 单声道 PCM16。
 *
 * AudioWorklet 小分片和停止握手避免大块 ScriptProcessor 截断尾音。
 */
export class PcmRecorder {
  readonly #options: PcmRecorderOptions & { targetSampleRate: number; chunkDurationMs: number };
  #context?: AudioContext;
  #preparing?: Promise<void>;
  #source?: MediaStreamAudioSourceNode;
  #processor?: AudioWorkletNode;
  #resampler?: StreamingResampler;
  #flushed?: () => void;
  #count = 0;
  #square = 0;
  #peak = 0;
  #clipped = 0;
  #silent = 0;
  #pending: number[] = [];
  #token = 0;
  #active = false;
  #stopping?: Promise<void>;
  #stream?: MediaStream;
  #disposed = false;

  constructor(options: PcmRecorderOptions) {
    this.#options = {
      audioContext: options.audioContext,
      targetSampleRate: options.targetSampleRate ?? 16_000,
      chunkDurationMs: options.chunkDurationMs ?? 100,
      onChunk: options.onChunk,
      onFirstSample: options.onFirstSample,
      onDiagnostics: options.onDiagnostics,
    };
  }

  /** 在按键前加载 Worklet；不申请麦克风，也不采集声音。 */
  async prepare(): Promise<void> {
    if (this.#disposed) throw new Error("recorder disposed");
    if (this.#preparing) return this.#preparing;
    if (this.#context) return;
    this.#preparing = (async () => {
      this.#context = this.#options.audioContext ?? new AudioContext({ sampleRate: 48_000 });
      // 保持独立同源资源，避免生产构建内联 data URL 后被原生 CSP 拦截。
      try {
        await this.#context.audioWorklet.addModule(new URL("./pcm-worklet.js?no-inline", import.meta.url));
      } catch (error) {
        if (!this.#options.audioContext) await this.#context.close();
        this.#context = undefined;
        throw error;
      }
    })();
    try { await this.#preparing; } finally { this.#preparing = undefined; }
  }

  /** 预先接通设备图；处理器常驻，门控关闭时不跨线程发送任何采样。 */
  async attach(stream: MediaStream): Promise<void> {
    await this.prepare();
    if (this.#disposed) throw new Error("recorder disposed");
    const context = this.#context!;
    await context.resume();
    if (this.#disposed || stream.getTracks?.().some((track) => track.readyState === "ended")) {
      throw new Error("microphone initialization cancelled");
    }
    if (this.#stream === stream && this.#processor) return;
    this.detach();
    this.#stream = stream;
    this.#source = context.createMediaStreamSource(stream);
    this.#processor = new AudioWorkletNode(context, "semi-os-capture", {
      channelCount: 1, channelCountMode: "explicit",
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const processor = this.#processor;
    const samplesPerChunk = Math.round(
      (this.#options.targetSampleRate * this.#options.chunkDurationMs) / 1000,
    );
    this.#processor.port.onmessage = ({ data }: MessageEvent<{ kind: string; token: number; samples?: Float32Array }>) => {
      // flush 超时或断开连接不保证消息队列已排空；旧节点不能向下一轮
      // 重采样器写音频，也不能替下一轮确认停止。
      if (this.#processor !== processor) return;
      if (data.token !== this.#token) return;
      if (data.kind === "flushed") { this.#flushed?.(); return; }
      if (!this.#active || !data.samples) return;
      if (this.#count === 0 && data.samples.length) this.#options.onFirstSample?.(this.#token);
      for (const sample of data.samples) {
        this.#count++; this.#square += sample * sample;
        this.#peak = Math.max(this.#peak, Math.abs(sample));
        if (Math.abs(sample) >= 0.99) this.#clipped++;
        if (Math.abs(sample) < 0.005) this.#silent++;
      }
      const resampled = this.#resampler!.push(data.samples);
      this.#pending.push(...resampled);
      while (this.#pending.length >= samplesPerChunk) {
        const samples = new Float32Array(
          this.#pending.splice(0, samplesPerChunk),
        );
        this.#options.onChunk(floatToPcm16(samples), this.#token);
      }
    };
    this.#source.connect(this.#processor);
    this.#processor.connect(context.destination);
  }

  /** 同步打开就绪设备的门控；无网络握手、无 getUserMedia 冷启动。 */
  begin(token: number): void {
    if (this.#disposed || !this.#processor || !this.#context || this.#active || this.#stopping) {
      throw new Error("microphone is not ready");
    }
    this.#token = token;
    this.#active = true;
    this.#count = this.#square = this.#peak = this.#clipped = this.#silent = 0;
    this.#pending = [];
    this.#resampler = new StreamingResampler(this.#context.sampleRate, this.#options.targetSampleRate);
    this.#processor.port.postMessage({ kind: "begin", token });
  }

  async start(stream: MediaStream, token = this.#token + 1): Promise<void> {
    await this.#stopping;
    await this.attach(stream);
    this.begin(token);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (!this.#processor || !this.#active) return;
    this.#stopping = this.#flush().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async #flush(): Promise<void> {
    const processor = this.#processor;
    if (processor && this.#context?.state === "running") {
      await new Promise<void>((resolve) => {
        // 系统挂起音频时不能无限等待；正常路径由 Worklet 的确认消息结束。
        const timer = setTimeout(resolve, 300);
        this.#flushed = () => { clearTimeout(timer); resolve(); };
        processor.port.postMessage({ kind: "end", token: this.#token });
      });
    } else processor?.port.postMessage({ kind: "end", token: this.#token });
    // 设备断开后旧尾部不能再进入发送链；新节点也不能被旧 flush 修改。
    if (this.#processor !== processor) return;
    this.#pending.push(...(this.#resampler?.flush() ?? []));
    if (this.#pending.length > 0) {
      this.#options.onChunk(floatToPcm16(new Float32Array(this.#pending)), this.#token);
      this.#pending = [];
    }
    this.#active = false;
    this.#flushed = undefined;
    if (this.#context) this.#options.onDiagnostics?.({
      sampleRateHz: this.#context.sampleRate,
      rms: Math.sqrt(this.#square / Math.max(1, this.#count)), peak: this.#peak,
      clippedSamples: this.#clipped, silenceRatio: this.#silent / Math.max(1, this.#count),
    }, this.#token);
    this.#resampler = undefined;
  }

  detach(): void {
    this.#active = false;
    this.#flushed?.();
    if (this.#processor) {
      this.#processor.port.onmessage = null;
      this.#processor.port.close();
      this.#processor.disconnect();
    }
    this.#source?.disconnect();
    this.#processor = undefined;
    this.#source = undefined;
    this.#stream = undefined;
    this.#pending = [];
    this.#resampler = undefined;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stop();
    this.detach();
    await this.#preparing?.catch(() => {});
    if (!this.#options.audioContext) await this.#context?.close();
    this.#context = undefined;
  }
}
