import type { RequestId, VoiceTurnAction, ResearchReport } from "@semi-os/protocol";
import type { ToolExecutionReceipt } from "@semi-os/tool-sdk";
import type { ToolDefinition } from "@semi-os/tool-sdk";
import type { AgentRuntimeAdapter, AgentRuntimeEvent } from "../runtime.ts";
import { SentenceBuffer } from "./sentence-buffer.ts";
import { normalizeAnswer, fallbackSpeech } from "./answer.ts";
import type { SttAudioChunk, SttProvider } from "./stt.ts";
import type { TtsProvider, WordTiming } from "./tts.ts";

export type VoiceLoopEvent =
  | { kind: "voice.answer"; payload: { taskId: string; summary: string; report: string } }
  | {
      kind: "voice.sentence";
      payload: { sentenceId: string; text: string; purpose: "answer" | "stage" | "confirmation" };
    }
  | { kind: "voice.timestamps"; payload: { sentenceId: string; words: WordTiming[] } }
  | { kind: "research.interrupted"; payload: { taskId: string; mode: string } }
  | { kind: "research.timing"; payload: { stage: string; durationMs: number } }
  | {
      kind: "research.progress";
      payload: { taskId: string; label: string; toolName: string; callId: string };
    }
  | { kind: "research.receipt"; payload: ToolExecutionReceipt }
  | { kind: "research.report"; payload: ResearchReport }
  | { kind: "voice.state"; payload: { state: string } }
  | { kind: "voice.transcript.partial"; payload: { text: string } }
  | { kind: "voice.transcript.final"; payload: { text: string } }
  | {
      kind: "voice.assistant.text_delta";
      payload: { text: string; source: "agent" };
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
  audio?: AsyncIterable<SttAudioChunk>;
}

export type TextTurn = Pick<VoiceTurn, "requestId" | "sessionId" | "taskId" | "cwd" | "action"> & {
  text: string;
};

export interface VoiceLoopOptions {
  runtime: AgentRuntimeAdapter;
  stt: SttProvider;
  tts: TtsProvider;
  tools?: readonly ToolDefinition[];
  explicitSpeech?: boolean;
  emit(event: VoiceLoopEvent): void;
  saveReport?: (report: ResearchReport, signal: AbortSignal) => Promise<void>;
}

/** 会话身份冲突必须保留独立错误分类，不能误报为 STT 或云端鉴权故障。 */
export class VoiceSessionMismatchError extends Error {
  constructor() {
    super("VoiceLoop cannot switch product sessions");
    this.name = "VoiceSessionMismatchError";
  }
}

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
  readonly #emit: (event: VoiceLoopEvent) => void;
  readonly #sentences: SentenceBuffer;
  #sessionId?: string;
  #taskId?: string;
  #generation = 0;
  #speech?: AbortController;
  #turn?: AbortController;
  #ttsQueue: Promise<void> = Promise.resolve();
  #sentenceSequence = 0;
  #acceptRuntimeEvents = false;
  #unsubscribe: () => void;
  readonly #saveReport?: VoiceLoopOptions["saveReport"];
  #answer = "";
  #finalAnswer = "";
  #speechPending = "";
  #speechHidden = false;
  #modelStarted = 0;
  #firstDelta = false;
  #firstSentenceReady = false;
  readonly #explicitSpeech: boolean;
  #speechAllowed = false;
  #speechMarker = "";
  #lastActionLabel = "";
  #answerSpeechQueued = false;
  #supervision?: AbortController;

  constructor(options: VoiceLoopOptions) {
    this.#runtime = options.runtime;
    this.#stt = options.stt;
    this.#tts = options.tts;
    this.#tools = options.tools ?? [];
    this.#emit = options.emit;
    this.#saveReport = options.saveReport;
    this.#explicitSpeech = options.explicitSpeech ?? false;
    // 仅明确的口头摘要允许长中文分句提前合成，报告与兼容输出仍按整句处理。
    this.#sentences = new SentenceBuffer({ chineseClauses: this.#explicitSpeech });
    this.#unsubscribe = this.#runtime.subscribe((event) => this.#onRuntimeEvent(event));
  }

  /** 两种输入只在转写前分叉，最终文本之后共享会话、工具、取消与 TTS。 */
  async run(turn: VoiceTurn | TextTurn): Promise<void> {
    const generation = ++this.#generation;
    this.#taskId = turn.taskId;
    this.#turn?.abort();
    this.#turn = new AbortController();
    const signal = this.#turn.signal;
    // 与录音/STT 重叠的可选握手只预热传输，不绕过 Pi 或提前合成回答。
    this.#tts.prepare?.(signal);
    this.#acceptRuntimeEvents = false;
    this.#sentences.clear();
    this.#answer = "";
    this.#finalAnswer = "";
    this.#speechPending = "";
    this.#speechHidden = false;
    this.#firstDelta = false;
    this.#firstSentenceReady = false;
    this.#speechAllowed = !this.#explicitSpeech;
    this.#speechMarker = "";
    this.#lastActionLabel = "";
    this.#answerSpeechQueued = false;
    let transcript: string | undefined;
    if ("text" in turn) {
      transcript = turn.text.trim();
      this.#emit({ kind: "voice.transcript.final", payload: { text: transcript } });
    } else {
      this.#emit({
        kind: "voice.state",
        payload: { state: turn.audio ? "listening" : "transcribing" },
      });
      const sttStarted = performance.now();
      let audioEndedAt: number | undefined;
      for await (const event of this.#stt.transcribe({
        audio: observeAudioEnd(turn.audio ?? arrayAudio(turn.chunks), () => {
          audioEndedAt = performance.now();
        }),
        signal,
      })) {
        if (signal.aborted || generation !== this.#generation) return;
        if (event.kind === "stt.partial") {
          this.#emit({
            kind: "voice.transcript.partial",
            payload: { text: event.text },
          });
        } else if (event.kind === "stt.final") {
          transcript = event.text.trim();
          // 实时识别总耗时包含用户说话时间；收尾指标只从 Provider 消费完
          // 音频后计起。未消费完输入就返回 final 时不伪造收尾耗时。
          this.#recordTiming("stt.total", sttStarted);
          if (audioEndedAt !== undefined) this.#recordTiming("stt.final", audioEndedAt);
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
    }
    if (!transcript) {
      this.#emit({
        kind: "voice.error",
        payload: {
          code: "stt_empty",
          message: "没有识别到语音，请检查麦克风输入后重试。",
          retryable: true,
        },
      });
      return;
    }

    // startSession 和 Provider 都可能在用户取消后才返回；每个异步边界后必须
    // 验证代际，避免已取消的指令继续进入 Pi 或重新开始播报。
    if (signal.aborted || generation !== this.#generation) {
      return;
    }
    const sessionStarted = performance.now();
    await this.#ensureSession(turn);
    if (signal.aborted || generation !== this.#generation) return;
    this.#recordTiming("session.ready", sessionStarted);
    this.#emit({ kind: "voice.state", payload: { state: "thinking" } });

    const input = { taskId: turn.taskId, text: transcript };
    this.#acceptRuntimeEvents = true;
    this.#modelStarted = performance.now();
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
    this.#supervision?.abort();
    this.#speech?.abort();
    this.#sentences.clear();
    this.#emit({ kind: "voice.audio.stop", payload: { reason: mode } });
    this.#emit({ kind: "research.interrupted", payload: { taskId, mode } });
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
    this.#supervision?.abort();
    this.#speech?.abort();
    this.#unsubscribe();
    await this.#runtime.dispose();
  }

  /** 等待动作提示生成并发出音频后才开始工具；实际播放结束由客户端队列负责。 */
  async waitForToolPreamble(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#supervision) return;
    await this.#ttsQueue;
    signal.throwIfAborted();
  }

  /** 后台事件进入同一个 Pi Session，禁用 STT/TTS 和聊天渲染，不创建新的 Agent Loop。 */
  async supervise(input: TextTurn, receipt: (value: ToolExecutionReceipt) => void): Promise<void> {
    const controller = new AbortController();
    this.#supervision = controller;
    this.#acceptRuntimeEvents = false;
    let failed = false;
    const unsubscribe = this.#runtime.subscribe((event) => {
      if (controller.signal.aborted) return;
      if (event.kind === "tool.completed") receipt(event.receipt);
      if (event.kind === "runtime.error") failed = true;
    });
    try {
      await this.#ensureSession(input);
      controller.signal.throwIfAborted();
      await this.#runtime.followUp({ taskId: input.taskId, text: input.text });
      if (controller.signal.aborted || failed) throw new Error("supervision interrupted");
    } finally {
      unsubscribe();
      if (this.#supervision === controller) this.#supervision = undefined;
    }
  }

  async #ensureSession(turn: VoiceTurn | TextTurn): Promise<void> {
    if (this.#sessionId === turn.sessionId) {
      return;
    }
    if (this.#sessionId) {
      throw new VoiceSessionMismatchError();
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
      if (!this.#firstDelta) {
        this.#firstDelta = true;
        this.#recordTiming("model.first_delta", this.#modelStarted);
      }
      this.#answer += event.text;
      this.#finalAnswer += event.text;
      // 结构化引用/报告保留在文字中，不向用户朗读 JSON 或长标识。
      let spoken = event.text;
      // 可播报段显式标记，模型过程不进入客户端；保留短尾部处理跨 token 标记。
      if (!this.#speechAllowed) {
        this.#speechMarker += event.text;
        const index = this.#speechMarker.indexOf("<speech>");
        if (index < 0) {
          this.#speechMarker = this.#speechMarker.slice(-8);
          return;
        }
        spoken = this.#speechMarker.slice(index + 8);
        this.#speechMarker = "";
        this.#speechAllowed = true;
      }
      for (const sentence of this.#sentences.push(this.#filterSpeech(spoken))) {
        this.#enqueueSpeech(sentence);
      }
    } else if (event.kind === "turn.completed") {
      const finalSpeech = this.#speechHidden
        ? ""
        : this.#speechPending.replace(/\[[^\]]*(?:source_|quote_)[^\]]*\]/g, "");
      this.#speechPending = "";
      for (const sentence of this.#sentences.push(finalSpeech)) this.#enqueueSpeech(sentence);
      const remainder = this.#sentences.flush();
      if (remainder) {
        this.#enqueueSpeech(remainder);
      }
      this.#acceptRuntimeEvents = false;
      const generation = this.#generation;
      const report = parseReport(this.#answer, event.taskId);
      const answer = normalizeAnswer(this.#answer, this.#explicitSpeech, report, this.#finalAnswer);
      if (!answer.summary.trim() && !answer.report.trim() && !report) {
        this.#emit({
          kind: "voice.error",
          payload: {
            code: "agent_empty_answer",
            message: "模型未返回回答，请重试。",
            retryable: true,
          },
        });
        this.#emit({ kind: "voice.state", payload: { state: "error" } });
        return;
      }
      // 仅在本轮结束后从最终 post-tool 回答保守取一句，不朗读工具前过程。
      const fallback =
        this.#explicitSpeech && !this.#answerSpeechQueued && !report
          ? fallbackSpeech(this.#finalAnswer)
          : "";
      if (fallback) {
        answer.summary = fallback;
        this.#enqueueSpeech(fallback);
      }
      this.#emit({ kind: "voice.answer", payload: { taskId: event.taskId, ...answer } });
      if (this.#explicitSpeech && !this.#answerSpeechQueued && !report && !fallback) {
        this.#emit({
          kind: "voice.error",
          payload: {
            code: "speech_marker_missing",
            message: "模型没有提供可播报的回复，文字仍可查看",
            retryable: true,
          },
        });
      }
      if (this.#answer.includes("```research-report") && !report) {
        this.#emit({
          kind: "voice.error",
          payload: {
            code: "research_report_invalid",
            message: "结构化调研报告格式无效，未保存为已核验报告",
            retryable: false,
          },
        });
      }
      if (report && this.#saveReport && this.#turn) {
        const signal = this.#turn.signal;
        this.#emit({
          kind: "research.progress",
          payload: {
            taskId: event.taskId,
            label: "比较来源",
            toolName: "research_report",
            callId: `report_${event.taskId}`,
          },
        });
        this.#ttsQueue = this.#ttsQueue.then(async () => {
          if (generation !== this.#generation || signal.aborted) return;
          try {
            await this.#saveReport!(report, signal);
            if (generation === this.#generation) {
              this.#emit({
                kind: "research.progress",
                payload: {
                  taskId: event.taskId,
                  label: "生成结论",
                  toolName: "research_report",
                  callId: `saved_${event.taskId}`,
                },
              });
              this.#emit({ kind: "research.report", payload: report });
              if (!this.#speechAllowed) await this.#speak(report.summary, "answer");
            }
          } catch (error) {
            if (generation === this.#generation)
              this.#emit({
                kind: "voice.error",
                payload: {
                  code: "research_report_rejected",
                  message: String(error),
                  retryable: false,
                },
              });
          }
        });
      }
      this.#ttsQueue = this.#ttsQueue.then(() => {
        if (generation === this.#generation) {
          this.#emit({ kind: "voice.turn.completed", payload: { taskId: event.taskId } });
          this.#emit({ kind: "voice.state", payload: { state: "idle" } });
        }
      });
    } else if (event.kind === "tool.requested") {
      // 缺少语音标记时仅保留最后一段面向用户的回答，工具前过程不得进入兜底报告。
      this.#finalAnswer = "";
      const labels: Record<string, string> = {
        browser_open: "搜索资料",
        browser_click: "搜索资料",
        browser_type: "搜索资料",
        browser_extract: "阅读来源",
      };
      const label = labels[event.toolName] ?? "执行工具";
      this.#emit({
        kind: "research.progress",
        payload: { taskId: this.#taskId!, label, toolName: event.toolName, callId: event.callId },
      });
      // 同阶段连续分段读取不反复播报，但每次工具事件仍完整进入时间线。
      if (labels[event.toolName] && this.#lastActionLabel !== label)
        this.#enqueueSpeech(`${label}。`, "stage");
      this.#lastActionLabel = label;
    } else if (event.kind === "tool.completed") {
      this.#emit({ kind: "research.receipt", payload: event.receipt });
    } else if (event.kind === "runtime.error") {
      this.#acceptRuntimeEvents = false;
      this.#emit({ kind: "voice.state", payload: { state: "error" } });
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

  /** 结构标记可能跨 token：保留未闭合片段，避免半个引用/JSON 进入 TTS。 */
  #filterSpeech(delta: string): string {
    if (this.#speechHidden) return "";
    this.#speechPending += delta;
    const endSpeech = this.#speechPending.indexOf("</speech>");
    if (endSpeech >= 0) {
      const prefix = this.#speechPending.slice(0, endSpeech);
      this.#speechPending = "";
      this.#speechHidden = true;
      return prefix.replace(/\[[^\]]*(?:source_|quote_)[^\]]*\]/g, "");
    }
    const fence = this.#speechPending.indexOf("```");
    if (fence >= 0) {
      const prefix = this.#speechPending.slice(0, fence);
      this.#speechPending = "";
      this.#speechHidden = true;
      return prefix.replace(/\[[^\]]*(?:source_|quote_)[^\]]*\]/g, "");
    }
    let end = this.#speechPending.length;
    const open = this.#speechPending.lastIndexOf("[");
    if (open > this.#speechPending.lastIndexOf("]")) end = open;
    const tick = /`{1,2}$/.exec(this.#speechPending);
    if (tick) end = Math.min(end, tick.index);
    const tag = this.#speechPending.lastIndexOf("<");
    if (tag > this.#speechPending.lastIndexOf(">")) end = Math.min(end, tag);
    const ready = this.#speechPending.slice(0, end);
    this.#speechPending = this.#speechPending.slice(end);
    return ready.replace(/\[[^\]]*(?:source_|quote_)[^\]]*\]/g, "");
  }

  #enqueueSpeech(sentence: string, purpose: "answer" | "stage" = "answer"): void {
    if (purpose === "answer") {
      this.#answerSpeechQueued = true;
      this.#markFirstSentenceReady();
    }
    const generation = this.#generation;
    this.#ttsQueue = this.#ttsQueue.then(async () => {
      if (generation === this.#generation) {
        await this.#speak(sentence, purpose);
      }
    });
  }

  async #speak(text: string, prefix: string): Promise<void> {
    // 报告摘要的兼容回退直接进入 speak，也必须计入首句指标。
    if (prefix === "answer") this.#markFirstSentenceReady();
    const generation = this.#generation;
    this.#speech?.abort();
    const controller = new AbortController();
    this.#speech = controller;
    const sentenceId = `${prefix}_${++this.#sentenceSequence}`;
    this.#emit({
      kind: "voice.sentence",
      payload: {
        sentenceId,
        text,
        purpose:
          prefix === "stage" ? "stage" : prefix === "confirmation" ? "confirmation" : "answer",
      },
    });
    let firstAudio = true;
    let firstAudioTimingEmitted = false;
    const started = performance.now();
    for await (const event of this.#tts.synthesize({
      sentenceId,
      text,
      signal: controller.signal,
    })) {
      if (generation !== this.#generation) {
        return;
      }
      if (event.kind === "tts.timestamps") {
        this.#emit({ kind: "voice.timestamps", payload: { sentenceId, words: event.words } });
      } else if (event.kind === "tts.first_audio_ready") {
        if (!firstAudioTimingEmitted) {
          firstAudioTimingEmitted = true;
          this.#recordTiming(`tts.${prefix}.first_audio`, started);
        }
      } else if (event.kind === "tts.audio") {
        // Provider 契约会先发 first_audio_ready；若兼容 Provider 没有发，
        // 第一块真实音频仍作为保守回退，避免首音频指标永久缺失。
        if (!firstAudioTimingEmitted) {
          firstAudioTimingEmitted = true;
          this.#recordTiming(`tts.${prefix}.first_audio`, started);
        }
        this.#emit({
          kind: "voice.audio.chunk",
          payload: {
            sentenceId,
            sequence: event.sequence,
            mimeType: event.mimeType,
            audioBase64: Buffer.from(event.data).toString("base64"),
            first: firstAudio,
          },
        });
        firstAudio = false;
      } else if (event.kind === "tts.completed") {
        this.#recordTiming(`tts.${prefix}.completed`, started);
        this.#emit({
          kind: "voice.audio.completed",
          payload: { sentenceId },
        });
      } else if (event.kind === "tts.error") {
        this.#emit({ kind: "voice.error", payload: event });
      }
    }
  }

  /** 首句耗时从本轮模型调用计起，阶段提示和确认语不能替代真实回答。 */
  #markFirstSentenceReady(): void {
    if (this.#firstSentenceReady) return;
    this.#firstSentenceReady = true;
    this.#recordTiming("speech.first_sentence_ready", this.#modelStarted);
  }

  #recordTiming(stage: string, started: number): void {
    this.#emit({
      kind: "research.timing",
      payload: { stage, durationMs: Math.max(0, Math.round(performance.now() - started)) },
    });
  }

  async announceConfirmation(): Promise<void> {
    const generation = this.#generation;
    this.#ttsQueue = this.#ttsQueue.then(async () => {
      if (generation === this.#generation)
        await this.#speak("这个操作需要确认，请在客户端确认是否执行。", "confirmation");
    });
    await this.#ttsQueue;
  }
}

/** 只有正常耗尽输入才记结束；取消迭代不能被误计为识别收尾。 */
async function* observeAudioEnd(
  audio: AsyncIterable<SttAudioChunk>,
  ended: () => void,
): AsyncIterable<SttAudioChunk> {
  for await (const chunk of audio) yield chunk;
  ended();
}

function parseReport(text: string, taskId: string): ResearchReport | undefined {
  const match = /```research-report\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]!) as ResearchReport;
    if (
      typeof value.summary !== "string" ||
      !Array.isArray(value.claims) ||
      !Array.isArray(value.limitations) ||
      !value.claims.every((claim) => claim && typeof claim.text === "string") ||
      !value.limitations.every((line) => typeof line === "string")
    )
      return undefined;
    return { ...value, taskId };
  } catch {
    return undefined;
  }
}

async function* arrayAudio(chunks: readonly SttAudioChunk[]): AsyncIterable<SttAudioChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
