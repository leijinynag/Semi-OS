import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  createVoiceEvent,
  parseVoiceRequest,
  type Envelope,
  type JsonValue,
  type RequestEnvelope,
  type RequestId,
  type VoiceRequestEnvelope,
  type VoiceTurnStartPayload,
} from "@semi-os/protocol";
import { PiAgentRuntime } from "./pi-runtime.ts";
import { readCloudLlmConfig, resolveCloudLlmModel } from "./config/llm.ts";
import { FakeSttProvider, FakeTtsProvider } from "./voice/fake-providers.ts";
import { DashScopeSttProvider } from "./voice/dashscope-stt.ts";
import { DashScopeTtsProvider } from "./voice/dashscope-tts.ts";
import { VoiceLoop, VoiceSessionMismatchError, type VoiceLoopEvent } from "./voice/voice-loop.ts";
import { BrowserService } from "./browser/browser-service.ts";
import { createBrowserTools } from "./browser/browser-tools.ts";
import { ResearchHost } from "./research-host.ts";
import { ToolRegistry } from "@semi-os/tool-sdk";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { digestToolInput } from "./tool-execution.ts";
import type { ApprovalBinding } from "@semi-os/tool-sdk";
import { AudioInput } from "./voice/audio-input.ts";
import { VOICE_SYSTEM_PROMPT } from "./voice/system-prompt.ts";

interface BufferedVoiceTurn
  extends Omit<VoiceTurnStartPayload, "action"> {
  requestId: RequestId;
  action: NonNullable<VoiceTurnStartPayload["action"]>;
  chunks: Array<{
    sequence: number;
    data: Uint8Array;
    mimeType: string;
    sampleRateHz?: number;
  }>;
  audio: AudioInput;
  nextSequence: number;
}

export interface VoiceLoopPort {
  run(turn: Parameters<VoiceLoop["run"]>[0]): Promise<void>;
  interrupt(
    taskId: string,
    mode: "pause" | "cancel" | "steer",
    text?: string,
  ): Promise<void>;
  dispose(): Promise<void>;
  announceConfirmation?(): Promise<void>;
}

export interface WorkerServiceOptions {
  pid?: number;
  environment?: NodeJS.ProcessEnv;
  emit(envelope: Envelope): void;
  createVoiceLoop?: (
    emit: (event: VoiceLoopEvent) => void,
  ) => VoiceLoopPort;
}

function response(
  request: RequestEnvelope,
  kind: string,
  payload: JsonValue,
): Envelope {
  return {
    direction: "response",
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    kind,
    payload,
  };
}

/**
 * Agent Worker 的长生命周期请求服务。
 *
 * JSONL 读取器可以继续接收中断请求，耗时的 STT/Agent/TTS 闭环在后台运行，
 * 事件通过原 requestId 回传。这里不并行处理同一录音的 append/commit，因此
 * sequence 校验可以在 Provider 前发现丢包或乱序。
 */
export class WorkerService {
  readonly #pid: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #emitEnvelope: (envelope: Envelope) => void;
  readonly #createVoiceLoop: NonNullable<WorkerServiceOptions["createVoiceLoop"]>;
  readonly #turns = new Map<RequestId, BufferedVoiceTurn>();
  #voiceLoop?: VoiceLoopPort;
  // 每个用户 Session 持有独立 Pi 上下文；切回时复用，不重建 Agent Loop。
  readonly #sessionLoops = new Map<string, VoiceLoopPort>();
  #activeRequestId?: RequestId;
  #activeTaskId?: string;
  #activeSessionId?: string;
  readonly #researchHost: ResearchHost;
  readonly #browser: BrowserService;

  constructor(options: WorkerServiceOptions) {
    this.#pid = options.pid ?? process.pid;
    this.#environment = options.environment ?? process.env;
    this.#emitEnvelope = options.emit;
    this.#researchHost = new ResearchHost(options.emit);
    this.#browser = new BrowserService({
      profileDir: this.#environment.SEMI_OS_BROWSER_PROFILE_DIR,
      headless: this.#environment.SEMI_OS_BROWSER_HEADLESS === "true",
      timing: (stage, durationMs) => {
        if (this.#activeRequestId) this.#emitEnvelope(createVoiceEvent(this.#activeRequestId, "research.timing", { stage, durationMs }));
      },
    });
    this.#createVoiceLoop =
      options.createVoiceLoop ??
      ((emit) => createConfiguredVoiceLoop(this.#environment, emit, this.#browser, this.#researchHost));
  }

  async handle(request: RequestEnvelope): Promise<Envelope> {
    if (request.kind === "research.confirmation.required") {
      const value = request.payload;
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof value.taskId !== "string") throw new Error("invalid confirmation notification");
      if (value.taskId === this.#activeTaskId) {
        // 只有 Host 确实要求确认才播报，不能用静态风险误报只读搜索。
        const loop = this.#voiceLoop;
        if (loop?.announceConfirmation) void loop.announceConfirmation().catch(() => {});
      }
      return response(request, "research.confirmation.announced", { accepted: true });
    }
    if (request.kind === "research.persisted") {
      this.#researchHost.acknowledge(request.payload);
      return response(request, "research.acknowledged", { accepted: true });
    }
    if (request.kind === "browser.login.open") {
      const payload = request.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.url !== undefined && typeof payload.url !== "string") throw new Error("invalid login payload");
      // 登录导航不能阻塞 JSONL 消费，否则中断/Host 确认都无法及时到达。
      void this.#browser.open(typeof payload.url === "string" ? payload.url : "https://www.bing.com", new AbortController().signal)
        .then((observation) => this.#emitEnvelope(response(request, "browser.login.opened", JSON.parse(JSON.stringify(observation)))))
        .catch(() => this.#emitEnvelope(response(request, "browser.login.failed", { message: "浏览器启动失败" })));
      return response(request, "browser.login.accepted", { accepted: true });
    }
    if (request.kind === "health.check") {
      return response(request, "health.ready", {
        worker: "semi-os-agent-worker",
        pid: this.#pid,
      });
    }

    const voiceRequest: VoiceRequestEnvelope = parseVoiceRequest(request);
    if (voiceRequest.kind === "voice.session.dispose") {
      const { sessionId } = voiceRequest.payload;
      // 先撤销事件身份再释放资源；dispose 期间的迟到回调不能再写入已删除的聊天。
      const loop = this.#sessionLoops.get(sessionId);
      this.#sessionLoops.delete(sessionId);
      for (const [id, turn] of this.#turns) {
        if (turn.sessionId === sessionId) {
          turn.audio.close(true);
          this.#turns.delete(id);
        }
      }
      if (this.#activeSessionId === sessionId) {
        this.#activeSessionId = undefined;
        this.#activeRequestId = undefined;
        this.#activeTaskId = undefined;
        this.#voiceLoop = undefined;
      }
      await loop?.dispose();
      return response(request, "voice.session.disposed", { sessionId });
    }
    if (voiceRequest.kind === "voice.text.submit") {
      // 与新录音一致，先关闭旧输入/停止旧代际，才绑定新轮次事件。
      for (const previous of this.#turns.values()) previous.audio.close(true);
      this.#turns.clear();
      if (this.#activeTaskId) await this.#voiceLoop?.interrupt(this.#activeTaskId, "pause");
      const payload = voiceRequest.payload;
      this.#activeRequestId = request.requestId;
      this.#activeTaskId = payload.taskId;
      this.#activeSessionId = payload.sessionId;
      this.#voiceLoop = this.#loop(payload.sessionId);
      void this.#voiceLoop.run({
        ...payload, requestId: request.requestId, action: payload.action ?? "prompt",
      }).catch((error: unknown) => {
        if (this.#activeRequestId !== request.requestId) return;
        const mismatch = error instanceof VoiceSessionMismatchError;
        this.#emitVoice(request.requestId, { kind: "voice.error", payload: {
          code: mismatch ? "voice_session_mismatch" : "text_loop_failed",
          message: mismatch ? "会话不同步，请重启客户端后重试" : "文字请求处理失败，请重试",
          retryable: !mismatch,
        } });
      }).finally(() => {
        if (this.#activeRequestId === request.requestId) this.#activeTaskId = undefined;
      });
      return response(request, "voice.text.accepted", { accepted: true });
    }
    if (voiceRequest.kind === "voice.turn.start") {
      const payload = voiceRequest.payload;
      if (this.#turns.size || this.#activeRequestId) {
        for (const previous of this.#turns.values()) previous.audio.close(true);
        this.#turns.clear();
        // 先停止旧代际再切换 requestId，旧事件不能错误关联到新录音。
        if (this.#activeTaskId) await this.#voiceLoop?.interrupt(this.#activeTaskId, "pause");
      }
      const turn: BufferedVoiceTurn = {
        requestId: request.requestId,
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        cwd: payload.cwd,
        mimeType: payload.mimeType,
        sampleRateHz: payload.sampleRateHz,
        action: payload.action ?? "prompt",
        chunks: [],
        audio: new AudioInput(),
        nextSequence: 0,
      };
      this.#turns.set(request.requestId, turn);
      this.#activeRequestId = request.requestId;
      this.#activeTaskId = payload.taskId;
      this.#activeSessionId = payload.sessionId;
      this.#voiceLoop = this.#loop(payload.sessionId);
      void this.#voiceLoop.run(turn).catch((error: unknown) => {
        // 日志与 UI 只保留受控错误分类，不输出异常正文/堆栈或 Provider 凭证。
        const mismatch = error instanceof VoiceSessionMismatchError;
        const code = mismatch ? "voice_session_mismatch" : "voice_loop_failed";
        process.stderr.write(
          `[agent-worker] ${code} request=${request.requestId}\n`,
        );
        if (this.#activeRequestId === request.requestId) {
          turn.audio.close(true);
          this.#emitVoice(request.requestId, { kind: "voice.error", payload: {
            code,
            message: mismatch ? "语音会话不同步，请重启客户端后重试" : "语音处理失败，请重试",
            retryable: !mismatch,
          } });
        }
      }).finally(() => {
        turn.audio.close(true);
        if (this.#activeRequestId === request.requestId) this.#activeTaskId = undefined;
      });
      this.#emitVoice(request.requestId, {
        kind: "voice.state",
        payload: { state: "listening" },
      });
      return response(request, "voice.turn.started", { accepted: true });
    }

    if (voiceRequest.kind === "voice.audio.append") {
      const turn = this.#requireTurn(request.requestId);
      const expected = turn.nextSequence;
      if (voiceRequest.payload.sequence !== expected) {
        throw new ProtocolValidationError(
          `audio sequence mismatch: expected ${expected}`,
          "invalid_payload",
        );
      }
      turn.audio.push({
        sequence: expected,
        data: Buffer.from(voiceRequest.payload.audioBase64, "base64"),
        mimeType: turn.mimeType,
        sampleRateHz: turn.sampleRateHz,
      });
      turn.nextSequence++;
      return response(request, "voice.audio.accepted", { sequence: expected });
    }

    if (voiceRequest.kind === "voice.turn.commit") {
      const turn = this.#requireTurn(request.requestId);
      if (voiceRequest.payload.lastSequence !== turn.nextSequence - 1) {
        throw new ProtocolValidationError(
          "commit does not match the last accepted audio sequence",
          "invalid_payload",
        );
      }
      this.#turns.delete(request.requestId);
      turn.audio.close();
      this.#emitVoice(request.requestId, { kind: "voice.state", payload: { state: "transcribing" } });
      return response(request, "voice.turn.committed", { accepted: true });
    }

    const payload = voiceRequest.payload;
    const targetRequestId = this.#activeRequestId ?? request.requestId;
    for (const turn of this.#turns.values()) turn.audio.close(true);
    this.#turns.clear();
    await this.#voiceLoop?.interrupt(
      payload.taskId,
      payload.mode,
      payload.text,
    );
    this.#emitVoice(targetRequestId, {
      kind: "voice.state",
      payload: { state: "interrupted" },
    });
    return response(request, "voice.interrupt.accepted", {
      mode: payload.mode,
    });
  }

  async dispose(): Promise<void> {
    for (const turn of this.#turns.values()) turn.audio.close(true);
    this.#turns.clear();
    const loops = [...this.#sessionLoops.values()];
    this.#sessionLoops.clear();
    this.#activeSessionId = undefined;
    this.#activeRequestId = undefined;
    this.#activeTaskId = undefined;
    this.#voiceLoop = undefined;
    await Promise.all(loops.map((loop) => loop.dispose()));
    this.#researchHost.dispose();
    await this.#browser.dispose();
  }

  #loop(sessionId: string): VoiceLoopPort {
    const existing = this.#sessionLoops.get(sessionId);
    if (existing) return existing;
    const loop = this.#createVoiceLoop((event) => {
      // 不活跃会话的迟到事件不得贴上当前会话身份；轮次内代际仍由 VoiceLoop 校验。
      if (this.#sessionLoops.get(sessionId) === loop && this.#activeSessionId === sessionId && this.#activeRequestId) {
        this.#emitVoice(this.#activeRequestId, event);
      }
    });
    this.#sessionLoops.set(sessionId, loop);
    return loop;
  }

  #requireTurn(requestId: RequestId): BufferedVoiceTurn {
    const turn = this.#turns.get(requestId);
    if (!turn) {
      throw new ProtocolValidationError(
        `voice turn is not open: ${requestId}`,
        "invalid_state",
      );
    }
    return turn;
  }

  #emitVoice(requestId: RequestId, event: VoiceLoopEvent): void {
    this.#emitEnvelope(
      createVoiceEvent(
        requestId,
        event.kind,
        (event.kind.startsWith("voice.") ? {
          ...event.payload, sessionId: this.#activeSessionId, taskId: this.#activeTaskId,
        } : event.payload) as JsonValue,
      ),
    );
  }
}

function createConfiguredVoiceLoop(
  environment: NodeJS.ProcessEnv,
  emit: (event: VoiceLoopEvent) => void,
  browser: BrowserService,
  researchHost: ResearchHost,
): VoiceLoop {
  const fixtureTranscript =
    environment.SEMI_OS_VOICE_FIXTURE_TRANSCRIPT?.trim();
  // 按用户体验反馈切换默认 ASR；保留显式 Qwen 回退，不混用两家的参数。
  const sttMode = environment.SEMI_OS_STT_PROVIDER?.trim() || "fun";
  const apiKey = environment.DASHSCOPE_API_KEY?.trim();
  if (!fixtureTranscript && !apiKey) {
    throw new Error(
      "voice provider is not configured; set DASHSCOPE_API_KEY in .env or SEMI_OS_VOICE_FIXTURE_TRANSCRIPT",
    );
  }
  const websocketUrl =
    environment.SEMI_OS_DASHSCOPE_WEBSOCKET_URL?.trim();
  const ttsVoice = environment.SEMI_OS_TTS_VOICE?.trim();
  if (!fixtureTranscript && !ttsVoice) {
    throw new Error(
      "voice provider is not configured; set SEMI_OS_TTS_VOICE to a ready voice_id created for the configured CosyVoice model",
    );
  }
  const approvals = new Map<string, ApprovalBinding>();
  let loop: VoiceLoop;
  const runtime = new PiAgentRuntime({
    systemPrompt: VOICE_SYSTEM_PROMPT,
    isolatedResources: true,
    beforeToolExecution: (signal) => loop.waitForToolPreamble(signal),
    resolvePolicyDecision: async (tool, input, taskId, signal) => {
      const inputDigest = digestToolInput(input);
      const approvalId = `approval_${randomUUID().replaceAll("-", "")}`;
      try {
        const effectiveSignal = signal ?? new AbortController().signal;
        const evidence = ["browser_click", "browser_type"].includes(tool.name)
          ? await browser.policyEvidence(String(input.pageId), Number(input.version), String(input.ref), effectiveSignal)
          : undefined;
        await researchHost.authorize({
          taskId, toolName: tool.name, riskLevel: tool.riskLevel, inputDigest, approvalId,
          inputJson: JSON.stringify(input), evidence,
        }, effectiveSignal);
        if (tool.riskLevel === "read" || tool.riskLevel === "local_write") return "auto";
        approvals.set(`${taskId}:${inputDigest}`, { approvalId, payloadDigest: inputDigest, approvedAtMs: Date.now() });
        return "approved";
      } catch { return "rejected"; }
    },
    approvalBinding: (taskId, input) => {
      const key = `${taskId}:${digestToolInput(input)}`;
      const binding = approvals.get(key);
      approvals.delete(key);
      return binding;
    },
    model: resolveCloudLlmModel(readCloudLlmConfig(environment)),
    additionalSkillPaths: [fileURLToPath(new URL("../../skills/research", import.meta.url))],
  });
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(browser, researchHost));
  loop = new VoiceLoop({
    runtime,
    tools: registry.activeTools({
      platform: process.platform, capabilities: new Map([["browser", { key: "browser", status: "available", observedAtMs: Date.now() }]]),
      workspaceAvailable: true, runtimeHealthy: true,
    }),
    saveReport: (report, signal) => researchHost.report(report, signal),
    explicitSpeech: true,
    stt: fixtureTranscript
      ? new FakeSttProvider(fixtureTranscript)
      : new DashScopeSttProvider({
          apiKey: apiKey!,
          websocketUrl,
          model: sttMode === "fun"
            ? (environment.SEMI_OS_FUN_STT_MODEL?.trim() || "fun-asr-realtime")
            : environment.SEMI_OS_STT_MODEL?.trim(),
          mode: sttMode === "fun" ? "fun" : "qwen",
          nearfield: environment.SEMI_OS_STT_NEARFIELD !== "false",
          languageHints: (environment.SEMI_OS_STT_LANGUAGES ?? "zh,en").split(",").map((text) => text.trim()).filter(Boolean),
          vocabulary: (environment.SEMI_OS_STT_HOTWORDS ?? "Semi-OS,Pi,Codex,Claude Code,飞书").split(",").map((text) => text.trim()).filter(Boolean),
          vocabularyId: environment.SEMI_OS_FUN_STT_VOCABULARY_ID?.trim(),
        }),
    tts: fixtureTranscript
      ? new FakeTtsProvider()
      : new DashScopeTtsProvider({
          // WebKit 不保证支持 MP3 MSE；PCM 可在首个分片到达时排入播放，
          // 而不必等待整句合成结束。Provider 协议细节仍封装在 Adapter 内。
          format: environment.SEMI_OS_TTS_FORMAT === "mp3" ? "mp3" : "pcm",
          apiKey: apiKey!,
          websocketUrl,
          model: environment.SEMI_OS_TTS_MODEL?.trim(),
          voice: ttsVoice!,
        }),
    emit,
  });
  return loop;
}
