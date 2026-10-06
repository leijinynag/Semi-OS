function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

interface QueuedSentence {
  sentenceId: string;
  mimeType: string;
  chunks: Uint8Array[];
  completed: boolean;
}

interface ActiveSentence extends QueuedSentence {
  audio: HTMLAudioElement;
  mediaSource?: MediaSource;
  sourceBuffer?: SourceBuffer;
  objectUrl?: string;
}

/**
 * 以 sentenceId 为播放边界，把 Worker 返回的音频按句排队。
 *
 * Worker 串行完成的是 TTS 生成而不是用户侧播放，因此新句到达不能停止上一句；
 * 正常切句只由 audio ended 驱动，`stop` 仅用于用户打断并清空整个队列。
 */
export class VoicePlayer {
  #active?: ActiveSentence;
  #queued: QueuedSentence[] = [];

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
    if (!active.mediaSource) {
      const parts = active.chunks.map((chunk) => chunk.slice().buffer);
      const blob = new Blob(parts, {
        type: active.mimeType,
      });
      active.objectUrl = URL.createObjectURL(blob);
      active.audio.src = active.objectUrl;
      void active.audio.play().catch(() => this.#finish(active));
      return;
    }
    this.#flush();
  }

  stop(): void {
    const active = this.#active;
    this.#active = undefined;
    this.#queued = [];
    if (active) {
      active.audio.pause();
      this.#revoke(active);
    }
  }

  #flush(): void {
    const active = this.#active;
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
      active.sourceBuffer.appendBuffer(next.slice().buffer);
      return;
    }
    if (active.completed) {
      active.mediaSource.endOfStream();
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
      audio: new Audio(),
    };
    this.#active = active;
    active.audio.addEventListener("ended", () => this.#finish(active), {
      once: true,
    });
    if (
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported(active.mimeType)
    ) {
      active.mediaSource = new MediaSource();
      active.objectUrl = URL.createObjectURL(active.mediaSource);
      active.audio.src = active.objectUrl;
      active.mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (
            this.#active !== active ||
            active.mediaSource?.readyState !== "open"
          ) {
            return;
          }
          active.sourceBuffer = active.mediaSource.addSourceBuffer(
            active.mimeType,
          );
          active.sourceBuffer.addEventListener("updateend", () => this.#flush());
          this.#flush();
          void active.audio.play().catch(() => this.#finish(active));
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
    this.#revoke(sentence);
    this.#active = undefined;
    const next = this.#queued.shift();
    if (next) {
      this.#activate(next);
    }
  }

  #revoke(sentence: ActiveSentence): void {
    if (sentence.objectUrl) {
      URL.revokeObjectURL(sentence.objectUrl);
    }
  }
}
