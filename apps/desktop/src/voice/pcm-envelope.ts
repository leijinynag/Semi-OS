export interface PcmEnvelope {
  windowSeconds: number;
  levels: Float32Array;
}

/** 跨字节分片读取 PCM16；一次预计算，播放时只按媒体时钟索引，不改变声音出口。 */
export function pcmEnvelope(chunks: readonly Uint8Array[], sampleRate = 22_050): PcmEnvelope {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("invalid PCM sample rate");
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const levels: number[] = [];
  let low: number | undefined;
  let square = 0;
  let count = 0;
  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (low === undefined) {
        low = byte;
        continue;
      }
      const raw = low | (byte << 8);
      const sample = (raw >= 0x8000 ? raw - 0x10000 : raw) / 0x8000;
      low = undefined;
      square += sample * sample;
      if (++count === windowSamples) {
        levels.push(Math.min(1, Math.sqrt(square / count) * 4));
        square = count = 0;
      }
    }
  }
  if (low !== undefined) throw new Error("incomplete PCM sample");
  if (count) levels.push(Math.min(1, Math.sqrt(square / count) * 4));
  return { windowSeconds: windowSamples / sampleRate, levels: Float32Array.from(levels) };
}

export function envelopeLevel(envelope: PcmEnvelope | undefined, seconds: number): number {
  if (!envelope || !Number.isFinite(seconds) || seconds < 0) return 0;
  return envelope.levels[Math.floor(seconds / envelope.windowSeconds)] ?? 0;
}

export function smoothLevel(previous: number, target: number, deltaSeconds: number): number {
  const rate = target > previous ? 36 : 9;
  return (
    previous +
    (target - previous) * (1 - Math.exp(-rate * Math.min(0.1, Math.max(0, deltaSeconds))))
  );
}
