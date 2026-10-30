const SENTENCE_END = /[。！？!?]\s*|\.(?=\s|$)/u;
const MIN_CLAUSE_HAN = 18;

/** 只在明确的口语摘要内启用自然停顿切分，默认仍保持完整句子的边界。 */
export interface SentenceBufferOptions {
  chineseClauses?: boolean;
}

export class SentenceBuffer {
  #buffer = "";
  readonly #chineseClauses: boolean;

  constructor(options: SentenceBufferOptions = {}) {
    this.#chineseClauses = options.chineseClauses ?? false;
  }

  push(delta: string): string[] {
    this.#buffer += delta;
    const sentences: string[] = [];
    let end = this.#nextEnd();
    while (end !== undefined) {
      const sentence = this.#buffer.slice(0, end).trim();
      if (sentence) {
        sentences.push(sentence);
      }
      this.#buffer = this.#buffer.slice(end);
      end = this.#nextEnd();
    }
    return sentences;
  }

  #nextEnd(): number | undefined {
    const match = SENTENCE_END.exec(this.#buffer);
    const hardEnd = match ? match.index + match[0].length : undefined;
    if (!this.#chineseClauses) return hardEnd;
    return chineseClauseEnd(this.#buffer.slice(0, hardEnd)) ?? hardEnd;
  }

  flush(): string | undefined {
    const text = this.#buffer.trim();
    this.#buffer = "";
    return text || undefined;
  }

  clear(): void {
    this.#buffer = "";
  }
}

/**
 * 不用字符数量强行截断：只选引号/括号外的中文停顿。
 * URL、代码及结构标记出现时放弃本段软切分；完整句末规则保持兼容。
 * 只计汉字，避免长英文名称或地址凑够阈值后被当作中文口语。
 */
function chineseClauseEnd(text: string): number | undefined {
  const closers: string[] = [];
  const pairs: Record<string, string> = {
    "“": "”",
    "‘": "’",
    "（": "）",
    "(": ")",
    "「": "」",
    "『": "』",
    '"': '"',
  };
  let han = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/[`<>\[\]{}]/u.test(character) || /^(?:https?:\/\/|www\.)/iu.test(text.slice(index)))
      return undefined;
    if (/\p{Script=Han}/u.test(character)) han += 1;
    if (closers.at(-1) === character) closers.pop();
    else if (pairs[character]) closers.push(pairs[character]!);
    else if (closers.length === 0 && han >= MIN_CLAUSE_HAN && /[，；]/u.test(character))
      return index + 1;
  }
  return undefined;
}
