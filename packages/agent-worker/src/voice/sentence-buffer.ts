const SENTENCE_END = /[。！？!?]\s*|\.(?=\s|$)/u;

export class SentenceBuffer {
  #buffer = "";

  push(delta: string): string[] {
    this.#buffer += delta;
    const sentences: string[] = [];
    let match = SENTENCE_END.exec(this.#buffer);
    while (match) {
      const end = match.index + match[0].length;
      const sentence = this.#buffer.slice(0, end).trim();
      if (sentence) {
        sentences.push(sentence);
      }
      this.#buffer = this.#buffer.slice(end);
      match = SENTENCE_END.exec(this.#buffer);
    }
    return sentences;
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
