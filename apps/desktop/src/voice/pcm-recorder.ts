export interface PcmRecorderOptions {
  targetSampleRate?: number;
  chunkDurationMs?: number;
  onChunk(data: Uint8Array): void;
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
 * ScriptProcessor 作为 MVP 的兼容实现，音频处理不承载业务状态；后续可替换
 * AudioWorklet 而不改变 VoiceClient 和 Worker 协议。
 */
export class PcmRecorder {
  readonly #options: Required<PcmRecorderOptions>;
  #context?: AudioContext;
  #source?: MediaStreamAudioSourceNode;
  #processor?: ScriptProcessorNode;
  #pending: number[] = [];

  constructor(options: PcmRecorderOptions) {
    this.#options = {
      targetSampleRate: options.targetSampleRate ?? 16_000,
      chunkDurationMs: options.chunkDurationMs ?? 100,
      onChunk: options.onChunk,
    };
  }

  async start(stream: MediaStream): Promise<void> {
    this.#context = new AudioContext();
    await this.#context.resume();
    this.#source = this.#context.createMediaStreamSource(stream);
    this.#processor = this.#context.createScriptProcessor(4096, 1, 1);
    const samplesPerChunk = Math.round(
      (this.#options.targetSampleRate * this.#options.chunkDurationMs) / 1000,
    );
    this.#processor.onaudioprocess = (event) => {
      const resampled = resampleMono(
        event.inputBuffer.getChannelData(0),
        this.#context?.sampleRate ?? this.#options.targetSampleRate,
        this.#options.targetSampleRate,
      );
      this.#pending.push(...resampled);
      while (this.#pending.length >= samplesPerChunk) {
        const samples = new Float32Array(
          this.#pending.splice(0, samplesPerChunk),
        );
        this.#options.onChunk(floatToPcm16(samples));
      }
    };
    this.#source.connect(this.#processor);
    this.#processor.connect(this.#context.destination);
  }

  async stop(): Promise<void> {
    if (this.#pending.length > 0) {
      this.#options.onChunk(floatToPcm16(new Float32Array(this.#pending)));
      this.#pending = [];
    }
    this.#processor?.disconnect();
    this.#source?.disconnect();
    await this.#context?.close();
    this.#processor = undefined;
    this.#source = undefined;
    this.#context = undefined;
  }
}
