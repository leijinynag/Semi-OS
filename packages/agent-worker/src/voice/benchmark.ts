/** 评测与延迟统计只处理显式提供的录音/记录；不接入常驻麦克风。 */
export const normalizeTranscript = (text: string) =>
  text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");

export function characterErrors(
  reference: string,
  transcript: string,
): { errors: number; characters: number } {
  const a = [...normalizeTranscript(reference)];
  const b = [...normalizeTranscript(transcript)];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return { errors: previous[b.length]!, characters: a.length };
}

export function percentile(values: number[], quantile: number): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))]!
    : null;
}

/** RIFF 逐块解析，拒绝损坏、立体声或错误采样率，避免比较不同输入。 */
export function wavePcm(bytes: Buffer): Uint8Array {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new Error("invalid benchmark WAV");
  }
  let validFormat = false;
  let data: Uint8Array | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("truncated WAV header");
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length + (length % 2) > bytes.length) throw new Error("truncated WAV chunk");
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "fmt ") {
      if (
        validFormat ||
        length < 16 ||
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt32LE(start + 4) !== 16_000 ||
        bytes.readUInt32LE(start + 8) !== 32_000 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16
      )
        throw new Error("expected mono PCM16 / 16000 Hz");
      validFormat = true;
    } else if (kind === "data") {
      if (data || length === 0 || length % 2) throw new Error("invalid WAV data");
      data = bytes.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  if (!validFormat || !data) throw new Error("missing WAV format or data");
  return data;
}
