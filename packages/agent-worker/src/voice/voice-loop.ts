import type { RequestId, VoiceTurnAction } from "@semi-os/protocol";
import type { ToolDefinition } from "@semi-os/tool-sdk";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
} from "../runtime.ts";
import { SentenceBuffer } from "./sentence-buffer.ts";
import type { SttAudioChunk, SttProvider } from "./stt.ts";
import type { TtsProvider } from "./tts.ts";

export type VoiceLoopEvent =
  | { kind: "voice.state"; payload: { state: string } }
  | { kind: "voice.transcript.partial"; payload: { text: string } }
  | { kind: "voice.transcript.final"; payload: { text: string } }
  | {
      kind: "voice.assistant.text_delta";
      payload: { text: string; source: "acknowledgement" | "agent" };
    }
  | {
      kind: "voice.audio.chunk";
      payload: {
        sentenceId: string;
        sequence: number;
        mimeType: string;
        audioBase64: string;
        first: boolean;
      };
    }
  | {
      kind: "voice.audio.completed";
      payload: { sentenceId: string };
    }
  | { kind: "voice.audio.stop"; payload: { reason: string } }
  | { kind: "voice.turn.completed"; payload: { taskId: string } }
  | {
      kind: "voice.error";
      payload: { code: string; message: string; retryable: boolean };
    };

export interface VoiceTurn {
  requestId: RequestId;
  sessionId: string;
  taskId: string;
  cwd: string;
  mimeType: string;
  sampleRateHz?: number;
  action: VoiceTurnAction;
  chunks: SttAudioChunk[];
}

export interface VoiceLoopOptions {
  runtime: AgentRuntimeAdapter;
  stt: SttProvider;
  tts: TtsProvider;
  tools?: readonly ToolDefinition[];
  acknowledgement?: string;
  emit(event: VoiceLoopEvent): void;
}

const DEFAULT_ACKNOWLEDGEMENT = "好的，我来处理。";

/**
 * 语音输入、Pi Session 和句子级 TTS 的唯一编排器。
 *
 * VoiceLoop 不判断任务是否成功，只把最终转写送入 Runtime，并消费结构化
 * Runtime 事件。中断通过 generation gate 丢弃旧音频，避免取消后迟到的
 * Provider 分片重新开始播放。
 */
export class VoiceLoop {
  readonly #runtime: AgentRuntimeAdapter;
  readonly #stt: SttProvider;
  readonly #tts: TtsProvider;
  readonly #tools: readonly ToolDefinition[];
  readonly #acknowledgement: string;
  readonly #emit: (event: VoiceLoopEvent) => void;
  readonly #sentences = new SentenceBuffer();
  #sessionId?: string;
  #taskId?: string;
  #generation = 0;
  #speech?: AbortController;
  #turn?: AbortController;
  #ttsQueue: Promise<void> = Promise.resolve();
  #sentenceSequence = 0;
  #acceptRuntimeEvents = false;
  #unsubscribe: () => void;

  constructor(options: VoiceLoopOptions) {
    this.#runtime = options.runtime;
    this.#stt = options.stt;
    this.#tts = options.tts;
    this.#tools = options.tools ?? [];
    this.#acknowledgement =
      options.acknowledgement ?? DEFAULT_ACKNOWLEDGEMENT;
    this.#emit = options.emit;
    this.#unsubscribe = this.#runtime.subscribe((event) =>
      this.#onRuntimeEvent(event),
    );
  }

  async run(turn: VoiceTurn): Promise<void> {
    const generation = ++this.#generation;
    this.#taskId = turn.taskId;
    this.#turn?.abort();
    this.#turn = new AbortController();
    const signal = this.#turn.signal;
    this.#acceptRuntimeEvents = false;
    this.#sentences.clear();
    this.#emit({ kind: "voice.state", payload: { state: "transcribing" } });

    let transcript: string | undefined;
    for await (const event of this.#stt.transcribe({
      audio: arrayAudio(turn.chunks),
      signal,
    })) {
      if (event.kind === "stt.partial") {
        this.#emit({
          kind: "voice.transcript.partial",
          payload: { text: event.text },
        });
      } else if (event.kind === "stt.final") {
        transcript = event.text.trim();
        this.#emit({
          kind: "voice.transcript.final",
          payload: { text: transcript },
        });
      } else if (event.kind === "stt.error") {
        this.#emit({ kind: "voice.error", payload: event });
        return;
      } else if (event.kind === "stt.cancelled") {
        this.#emit({ kind: "voice.state", payload: { state: "interrupted" } });
        return;
      }
    }
    if (!transcript) {
      this.#emit({ kind: "voice.state", payload: { state: "idle" } });
      return;
    }

    await this.#ensureSession(turn);
    // startSession 和 Provider 都可能在用户取消后才返回；每个异步边界后必须
    // 验证代际，避免已取消的指令继续进入 Pi 或重新开始播报。
    if (signal.aborted || generation !== this.#generation) {
      return;
    }
    this.#emit({
      kind: "voice.assistant.text_delta",
      payload: { text: this.#acknowledgement, source: "acknowledgement" },
    });
    // 确认语音与 Pi 推理并行启动，避免等待整段 TTS 生成后才让模型工作。
    // 正式回复仍追加到同一队列，因此播放顺序始终是确认语 -> Agent 首句。
    this.#ttsQueue = this.#ttsQueue.then(async () => {
      if (generation === this.#generation) {
        await this.#speak(this.#acknowledgement, "ack");
      }
    });
    this.#emit({ kind: "voice.state", payload: { state: "thinking" } });

    const input = { taskId: turn.taskId, text: transcript };
    this.#acceptRuntimeEvents = true;
    if (turn.action === "steer") {
      await this.#runtime.steer(input);
    } else if (turn.action === "follow_up") {
      await this.#runtime.followUp(input);
    } else {
      await this.#runtime.prompt(input);
    }
    await this.#ttsQueue;
  }

  async interrupt(
    taskId: string,
    mode: "pause" | "cancel" | "steer",
    text?: string,
  ): Promise<void> {
    this.#generation += 1;
    this.#acceptRuntimeEvents = false;
    this.#turn?.abort();
    this.#speech?.abort();
    this.#sentences.clear();
    this.#emit({ kind: "voice.audio.stop", payload: { reason: mode } });
    this.#emit({ kind: "voice.state", payload: { state: "interrupted" } });
    if (mode === "pause") {
      await this.#runtime.pause(taskId);
    } else if (mode === "cancel") {
      await this.#runtime.abort(taskId);
    } else if (text?.trim()) {
      await this.#runtime.steer({ taskId, text: text.trim() });
    }
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    this.#turn?.abort();
    this.#speech?.abort();
    this.#unsubscribe();
    await this.#runtime.dispose();
  }

  async #ensureSession(turn: VoiceTurn): Promise<void> {
    if (this.#sessionId === turn.sessionId) {
      return;
    }
    if (this.#sessionId) {
      throw new Error("VoiceLoop cannot switch product sessions");
    }
    await this.#runtime.startSession({
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      cwd: turn.cwd,
      tools: this.#tools,
    });
    this.#sessionId = turn.sessionId;
  }

  #onRuntimeEvent(event: AgentRuntimeEvent): void {
    // pause/abort 完成期间 Pi 仍可能发出最后一批 text_delta/agent_end；这些事件
    // 属于已失效轮次，不能把 interrupted 覆盖为 speaking 或 idle。
    if (!this.#acceptRuntimeEvents) {
      return;
    }
    if (event.kind === "assistant.text_delta") {
      this.#emit({
        kind: "voice.assistant.text_delta",
        payload: { text: event.text, source: "agent" },
      });
      for (const sentence of this.#sentences.push(event.text)) {
        this.#enqueueSpeech(sentence);
      }
    } else if (event.kind === "turn.completed") {
      const remainder = this.#sentences.flush();
      if (remainder) {
        this.#enqueueSpeech(remainder);
      }
      this.#acceptRuntimeEvents = false;
      const generation = this.#generation;
      this.#ttsQueue = this.#ttsQueue.then(() => {
        if (generation === this.#generation) {
          this.#emit({
            kind: "voice.turn.completed",
            payload: { taskId: event.taskId },
          });
          this.#emit({ kind: "voice.state", payload: { state: "idle" } });
        }
      });
    } else if (event.kind === "runtime.error") {
      this.#emit({
        kind: "voice.error",
        payload: {
          code: "agent_runtime_failed",
          message: event.message,
          retryable: true,
        },
      });
    }
  }

  #enqueueSpeech(sentence: string): void {
    const generation = this.#generation;
    this.#ttsQueue = this.#ttsQueue.then(async () => {
      if (generation === this.#generation) {
        await this.#speak(sentence, "answer");
      }
    });
  }

  async #speak(text: string, prefix: string): Promise<void> {
    const generation = this.#generation;
    this.#speech?.abort();
    const controller = new AbortController();
    this.#speech = controller;
    const sentenceId = `${prefix}_${++this.#sentenceSequence}`;
    let first = true;
    for await (const event of this.#tts.synthesize({
      sentenceId,
      text,
      signal: controller.signal,
    })) {
      if (generation !== this.#generation) {
        return;
      }
      if (event.kind === "tts.first_audio_ready") {
        this.#emit({ kind: "voice.state", payload: { state: "speaking" } });
      } else if (event.kind === "tts.audio") {
        this.#emit({
          kind: "voice.audio.chunk",
          payload: {
            sentenceId,
            sequence: event.sequence,
            mimeType: event.mimeType,
            audioBase64: Buffer.from(event.data).toString("base64"),
            first,
          },
        });
        first = false;
      } else if (event.kind === "tts.completed") {
        this.#emit({
          kind: "voice.audio.completed",
          payload: { sentenceId },
        });
      } else if (event.kind === "tts.error") {
        this.#emit({ kind: "voice.error", payload: event });
      }
    }
  }
}

async function* arrayAudio(
  chunks: readonly SttAudioChunk[],
): AsyncIterable<SttAudioChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
