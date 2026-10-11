import type { SttAudioChunk } from "./stt.ts";

/**
 * 有界的实时音频入口；结束/取消都唤醒等待的消费者，不占用 JSONL 请求处理器。
 * 只缓存尚未发出的音频，禁止用无限数组保存整个录音。
 */
export class AudioInput implements AsyncIterable<SttAudioChunk> {
  #chunks: SttAudioChunk[] = [];
  #bytes = 0;
  #ended = false;
  #wake?: () => void;

  push(chunk: SttAudioChunk): void {
    if (this.#ended) throw new Error("audio input is closed");
    if (this.#bytes + chunk.data.byteLength > 16_000 * 2 * 30) {
      this.close();
      throw new Error("audio input backpressure limit exceeded");
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.data.byteLength;
    this.#wake?.();
  }

  close(discard = false): void {
    this.#ended = true;
    if (discard) { this.#chunks = []; this.#bytes = 0; }
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SttAudioChunk> {
    try {
      while (true) {
        const chunk = this.#chunks.shift();
        if (chunk) {
          this.#bytes -= chunk.data.byteLength;
          yield chunk;
        } else if (this.#ended) return;
        else await new Promise<void>((resolve) => { this.#wake = resolve; });
      }
    } finally { this.#wake = undefined; }
  }
}
