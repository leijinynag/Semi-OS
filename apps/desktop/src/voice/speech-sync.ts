export interface SpeechWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** 时间戳必须覆盖原句、单调且有界；不可靠数据退回逐句，不能匀速猜字。 */
export function validateWords(value: unknown, text: string): SpeechWord[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 4096) return undefined;
  let previous = 0;
  const words: SpeechWord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const { text: word, startMs, endMs } = item as Record<string, unknown>;
    if (typeof word !== "string" || !word || typeof startMs !== "number" ||
      typeof endMs !== "number" || !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
      startMs < previous || endMs < startMs || endMs > 600_000) return undefined;
    words.push({ text: word, startMs, endMs });
    previous = endMs;
  }
  const compact = (input: string) => input.replace(/[\s\p{P}\p{S}]/gu, "");
  return compact(words.map((word) => word.text).join("")) === compact(text) ? words : undefined;
}

export function spokenPrefix(text: string, words: SpeechWord[] | undefined, positionMs: number): string {
  if (!words) return text;
  let end = 0;
  for (const word of words) {
    if (word.startMs > positionMs) break;
    const index = text.indexOf(word.text, end);
    if (index < 0) return text;
    end = index + word.text.length;
  }
  return end ? text.slice(0, end) : "";
}
