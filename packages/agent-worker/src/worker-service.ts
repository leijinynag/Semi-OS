import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  createVoiceEvent,
  parseVoiceRequest,
  parseRequestMessage,
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
import { WorkflowHost } from "./collaboration/workflow-host.ts";
import { createWorkflowTools, createCoordinatorTools } from "./collaboration/workflow-tools.ts";
import { CollaborationService } from "./collaboration/service.ts";
import { WorkspaceService, NeedsUserError } from "./collaboration/workspaces.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkflowCoordinator } from "./collaboration/coordinator.ts";
import type { AgentRuntimeAdapter } from "./runtime.ts";
import type { WorkflowSnapshot } from "@semi-os/protocol";

interface BufferedVoiceTurn extends Omit<VoiceTurnStartPayload, "action"> {
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
  interrupt(taskId: string, mode: "pause" | "cancel" | "steer", text?: string): Promise<void>;
  dispose(): Promise<void>;
  announceConfirmation?(): Promise<void>;
  supervise?(
    input: Parameters<VoiceLoop["supervise"]>[0],
    receipt: Parameters<VoiceLoop["supervise"]>[1],
  ): Promise<void>;
}

export interface WorkerServiceOptions {
  pid?: number;
  environment?: NodeJS.ProcessEnv;
  emit(envelope: Envelope): void;
  createVoiceLoop?: (emit: (event: VoiceLoopEvent) => void, sessionId: string) => VoiceLoopPort;
  createCoordinatorRuntime?: (snapshot: WorkflowSnapshot) => AgentRuntimeAdapter;
}

function response(request: RequestEnvelope, kind: string, payload: JsonValue): Envelope {
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
  readonly #workflowHost: WorkflowHost;
  readonly #collaboration: CollaborationService;
  readonly #coordinator: WorkflowCoordinator;
  readonly #userTurns = new Map<string, RequestId>();
  readonly #deletedSessions = new Set<string>();
  readonly #sessionCwd = new Map<string, string>();
  readonly #operations = new Set<Promise<void>>();
  readonly #operationAbort = new AbortController();
  #disposed = false;

  constructor(options: WorkerServiceOptions) {
    this.#pid = options.pid ?? process.pid;
    this.#environment = options.environment ?? process.env;
    this.#emitEnvelope = options.emit;
    this.#researchHost = new ResearchHost(options.emit);
    this.#workflowHost = new WorkflowHost(options.emit);
    this.#collaboration = new CollaborationService(
      this.#workflowHost,
      this.#researchHost,
      new WorkspaceService(
        this.#environment.SEMI_OS_WORKTREE_DIR ?? join(homedir(), ".semi-os", "worktrees"),
      ),
    );
    this.#coordinator = new WorkflowCoordinator({
      host: this.#workflowHost,
      directory:
        this.#environment.SEMI_OS_COORDINATOR_DIR ?? join(homedir(), ".semi-os", "coordinators"),
      runtime:
        options.createCoordinatorRuntime ??
        (() =>
          new PiAgentRuntime({
            isolatedResources: true,
            baseToolNames: [],
            systemPrompt:
              "你是 Semi-OS 后台工作流协调者。通过协作工具组织已批准工作流。只能处理授权范围内的实现细节；用户意图最高优先。不要播报，不调用语音。先观察，不重复派发已有/未知尝试。无新事件时结束轮次等待通知。完成必须真实测试和独立审查。目标或权限变更需真人重新批准。",
            model: resolveCloudLlmModel(readCloudLlmConfig(this.#environment)),
            additionalSkillPaths: [
              fileURLToPath(new URL("../../skills/collaboration", import.meta.url)),
            ],
            resolvePolicyDecision: async () => "auto",
          })),
      tools: (snapshot) =>
        createCoordinatorTools(this.#workflowHost, snapshot, this.#collaboration),
      restoreQueued: (snapshot, signal) => this.#collaboration.restoreQueued(snapshot, signal),
    });
    this.#browser = new BrowserService({
      profileDir: this.#environment.SEMI_OS_BROWSER_PROFILE_DIR,
      headless: this.#environment.SEMI_OS_BROWSER_HEADLESS === "true",
      timing: (stage, durationMs) => {
        if (this.#activeRequestId)
          this.#emitEnvelope(
            createVoiceEvent(this.#activeRequestId, "research.timing", { stage, durationMs }),
          );
      },
    });
    this.#createVoiceLoop =
      options.createVoiceLoop ??
      ((emit, sessionId) =>
        createConfiguredVoiceLoop(
          this.#environment,
          emit,
          this.#browser,
          this.#researchHost,
          this.#workflowHost,
          sessionId,
          this.#collaboration,
        ));
  }

  async handle(input: RequestEnvelope): Promise<Envelope> {
    const request = parseRequestMessage(input);
    switch (request.kind) {
      case "workflow.application.prepare":
      case "workflow.application.apply": {
        const payload = request.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          typeof payload.sessionId !== "string" ||
          typeof payload.workflowId !== "string" ||
          (request.kind.endsWith(".apply") && typeof payload.applicationId !== "string")
        )
          throw new Error("invalid application command");
        const operation = request.kind.endsWith(".prepare")
          ? this.#collaboration.prepareApplication(
              payload.sessionId,
              payload.workflowId,
              this.#operationAbort.signal,
            )
          : this.#collaboration.applyApplication(
              payload.sessionId,
              payload.workflowId,
              String(payload.applicationId),
              this.#operationAbort.signal,
            );
        this.#track(
          operation
            .then((value) =>
              this.#emitEnvelope(
                response(
                  request,
                  "workflow.run.result",
                  JSON.parse(JSON.stringify({ ok: true, value })),
                ),
              ),
            )
            .catch((cause: unknown) =>
              this.#emitEnvelope(
                response(request, "workflow.run.result", {
                  ok: false,
                  error:
                    cause instanceof NeedsUserError
                      ? cause.message
                      : "应用未确认，请核对源分支和工作区，禁止重复操作",
                }),
              ),
            ),
        );
        return response(request, "workflow.run.accepted", { accepted: true });
      }
      case "workflow.run.inspect":
      case "workflow.run.reconcile":
      case "workflow.run.steer":
      case "workflow.run.answer": {
        const payload = request.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          typeof payload.sessionId !== "string" ||
          typeof payload.workflowId !== "string" ||
          typeof payload.runId !== "string"
        )
          throw new Error("invalid workflow run action");
        // 只接受 Host 的用户入口，模型工具和通用 WebView 通道不能伪造核对批准。
        if (
          "text" in payload &&
          (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 8000)
        )
          throw new Error("invalid workflow instruction");
        const operation =
          request.kind === "workflow.run.inspect"
            ? this.#collaboration.inspectRun(
                payload.sessionId,
                payload.workflowId,
                payload.runId,
                this.#operationAbort.signal,
              )
            : request.kind === "workflow.run.reconcile"
              ? this.#collaboration.reconcile(
                  payload.sessionId,
                  payload.workflowId,
                  payload.runId,
                  this.#operationAbort.signal,
                )
              : this.#collaboration
                  .userInstruction(
                    payload.sessionId,
                    payload.workflowId,
                    payload.runId,
                    "text" in payload ? payload.text : "",
                    request.kind === "workflow.run.answer",
                    this.#operationAbort.signal,
                  )
                  .then(() => {
                    this.#drainSupervision(
                      payload.sessionId as string,
                      payload.workflowId as string,
                    );
                    return { accepted: true };
                  });
        const pending = operation
          .then((value) =>
            this.#emitEnvelope(
              response(
                request,
                "workflow.run.result",
                JSON.parse(JSON.stringify({ ok: true, value })),
              ),
            ),
          )
          .catch(() =>
            this.#emitEnvelope(
              response(request, "workflow.run.result", {
                ok: false,
                error: "核对失败，工作区保留；请检查仓库和 Worker 状态",
              }),
            ),
          );
        this.#track(pending);
        return response(request, "workflow.run.accepted", { accepted: true });
      }
      case "workflow.control": {
        const payload = request.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          typeof payload.workflowId !== "string" ||
          typeof payload.sessionId !== "string" ||
          ![
            "approved",
            "rejected",
            "needs_revision",
            "pause",
            "resume",
            "resume_coordinator",
            "cancel",
            "observe",
            "reconcile_application",
            "answer_decision",
          ].includes(String(payload.action))
        )
          throw new Error("invalid workflow control");
        // 不等待子进程关闭阻塞 JSONL，否则取消期间的 Host 持久化回执无法到达。
        const sessionId = payload.sessionId;
        const stopping = ["rejected", "needs_revision", "pause", "cancel"].includes(
          String(payload.action),
        )
          ? Promise.all([
              this.#coordinator.stop(payload.workflowId),
              this.#collaboration.stopWorkflow(payload.workflowId),
            ]).then(() => {})
          : Promise.resolve();
        this.#track(
          stopping
            .then(async () => {
              if (payload.action === "answer_decision") {
                if (typeof payload.requestId !== "string")
                  throw new Error("missing decision identity");
                await this.#collaboration.resolveDecision(
                  payload.workflowId as string,
                  payload.requestId,
                  this.#operationAbort.signal,
                );
              }
              this.#drainSupervision(sessionId, payload.workflowId as string);
            })
            .catch(() => {}),
        );
        return response(request, "workflow.control.accepted", { accepted: true });
      }
      case "workflow.acknowledged": {
        this.#workflowHost.acknowledge(request.payload);
        return response(request, "workflow.received", { accepted: true });
      }
      case "research.confirmation.required": {
        const value = request.payload;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof value.taskId !== "string"
        )
          throw new Error("invalid confirmation notification");
        if (value.taskId === this.#activeTaskId) {
          // 只有 Host 确实要求确认才播报，不能用静态风险误报只读搜索。
          const loop = this.#voiceLoop;
          if (loop?.announceConfirmation) void loop.announceConfirmation().catch(() => {});
        }
        return response(request, "research.confirmation.announced", { accepted: true });
      }
      case "research.persisted": {
        this.#researchHost.acknowledge(request.payload);
        return response(request, "research.acknowledged", { accepted: true });
      }
      case "browser.login.open": {
        const payload = request.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          (payload.url !== undefined && typeof payload.url !== "string")
        )
          throw new Error("invalid login payload");
        // 登录导航不能阻塞 JSONL 消费，否则中断/Host 确认都无法及时到达。
        void this.#browser
          .open(
            typeof payload.url === "string" ? payload.url : "https://www.bing.com",
            new AbortController().signal,
          )
          .then((observation) =>
            this.#emitEnvelope(
              response(request, "browser.login.opened", JSON.parse(JSON.stringify(observation))),
            ),
          )
          .catch(() =>
            this.#emitEnvelope(
              response(request, "browser.login.failed", { message: "浏览器启动失败" }),
            ),
          );
        return response(request, "browser.login.accepted", { accepted: true });
      }
      case "health.check": {
        return response(request, "health.ready", {
          worker: "semi-os-agent-worker",
          pid: this.#pid,
        });
      }

      case "voice.session.dispose":
      case "voice.text.submit":
      case "voice.turn.start":
      case "voice.audio.append":
      case "voice.turn.commit":
      case "voice.interrupt":
        return this.#handleVoice(request);
      case "fixture.request":
        throw new ProtocolValidationError(
          "Fixture requests are not product operations",
          "unsupported_request",
        );
      default: {
        const unhandled: never = request;
        throw new Error(String(unhandled));
      }
    }
  }

  async #handleVoice(request: RequestEnvelope): Promise<Envelope> {
    const voiceRequest: VoiceRequestEnvelope = parseVoiceRequest(request);
    if (voiceRequest.kind === "voice.session.dispose") {
      const { sessionId } = voiceRequest.payload;
      this.#deletedSessions.add(sessionId);
      this.#userTurns.delete(sessionId);
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
      const payload = voiceRequest.payload;
      // 必须在第一个 await 前占住会话；监督 finally 不得抢在用户轮次前再次启动。
      this.#deletedSessions.delete(payload.sessionId);
      this.#userTurns.set(payload.sessionId, request.requestId);
      try {
        // 与新录音一致，先关闭旧输入/停止旧代际，才绑定新轮次事件。
        for (const previous of this.#turns.values()) previous.audio.close(true);
        this.#turns.clear();
        if (this.#activeTaskId) await this.#voiceLoop?.interrupt(this.#activeTaskId, "pause");
        await this.#yieldSupervision(payload.sessionId);
        this.#sessionCwd.set(payload.sessionId, payload.cwd);
        this.#activeRequestId = request.requestId;
        this.#activeTaskId = payload.taskId;
        this.#activeSessionId = payload.sessionId;
        this.#voiceLoop = this.#loop(payload.sessionId);
        void this.#voiceLoop
          .run({
            ...payload,
            requestId: request.requestId,
            action: payload.action ?? "prompt",
          })
          .catch((error: unknown) => {
            if (this.#activeRequestId !== request.requestId) return;
            const mismatch = error instanceof VoiceSessionMismatchError;
            this.#emitVoice(request.requestId, {
              kind: "voice.error",
              payload: {
                code: mismatch ? "voice_session_mismatch" : "text_loop_failed",
                message: mismatch ? "会话不同步，请重启客户端后重试" : "文字请求处理失败，请重试",
                retryable: !mismatch,
              },
            });
          })
          .finally(() => {
            if (this.#userTurns.get(payload.sessionId) === request.requestId)
              this.#userTurns.delete(payload.sessionId);
            if (this.#activeRequestId === request.requestId) this.#activeTaskId = undefined;
            this.#drainSupervision(payload.sessionId);
          });
        return response(request, "voice.text.accepted", { accepted: true });
      } catch (cause) {
        if (this.#userTurns.get(payload.sessionId) === request.requestId)
          this.#userTurns.delete(payload.sessionId);
        this.#drainSupervision(payload.sessionId);
        throw cause;
      }
    }
    if (voiceRequest.kind === "voice.turn.start") {
      const payload = voiceRequest.payload;
      this.#deletedSessions.delete(payload.sessionId);
      this.#userTurns.set(payload.sessionId, request.requestId);
      try {
        await this.#yieldSupervision(payload.sessionId);
        this.#sessionCwd.set(payload.sessionId, payload.cwd);
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
        void this.#voiceLoop
          .run(turn)
          .catch((error: unknown) => {
            // 日志与 UI 只保留受控错误分类，不输出异常正文/堆栈或 Provider 凭证。
            const mismatch = error instanceof VoiceSessionMismatchError;
            const code = mismatch ? "voice_session_mismatch" : "voice_loop_failed";
            process.stderr.write(`[agent-worker] ${code} request=${request.requestId}\n`);
            if (this.#activeRequestId === request.requestId) {
              turn.audio.close(true);
              this.#emitVoice(request.requestId, {
                kind: "voice.error",
                payload: {
                  code,
                  message: mismatch ? "语音会话不同步，请重启客户端后重试" : "语音处理失败，请重试",
                  retryable: !mismatch,
                },
              });
            }
          })
          .finally(() => {
            turn.audio.close(true);
            if (this.#userTurns.get(payload.sessionId) === request.requestId)
              this.#userTurns.delete(payload.sessionId);
            if (this.#activeRequestId === request.requestId) this.#activeTaskId = undefined;
            this.#drainSupervision(payload.sessionId);
          });
        this.#emitVoice(request.requestId, {
          kind: "voice.state",
          payload: { state: "listening" },
        });
        return response(request, "voice.turn.started", { accepted: true });
      } catch (cause) {
        if (this.#userTurns.get(payload.sessionId) === request.requestId)
          this.#userTurns.delete(payload.sessionId);
        this.#drainSupervision(payload.sessionId);
        throw cause;
      }
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
      this.#emitVoice(request.requestId, {
        kind: "voice.state",
        payload: { state: "transcribing" },
      });
      return response(request, "voice.turn.committed", { accepted: true });
    }

    const payload = voiceRequest.payload;
    const targetRequestId = this.#activeRequestId ?? request.requestId;
    for (const turn of this.#turns.values()) turn.audio.close(true);
    this.#turns.clear();
    await this.#voiceLoop?.interrupt(payload.taskId, payload.mode, payload.text);
    this.#emitVoice(targetRequestId, {
      kind: "voice.state",
      payload: { state: "interrupted" },
    });
    return response(request, "voice.interrupt.accepted", {
      mode: payload.mode,
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#operationAbort.abort();
    for (const turn of this.#turns.values()) turn.audio.close(true);
    this.#turns.clear();
    const loops = [...this.#sessionLoops.values()];
    this.#sessionLoops.clear();
    this.#activeSessionId = undefined;
    this.#activeRequestId = undefined;
    this.#activeTaskId = undefined;
    this.#voiceLoop = undefined;
    await Promise.all(loops.map((loop) => loop.dispose()));
    await this.#coordinator.dispose();
    await this.#collaboration.dispose();
    await Promise.allSettled(this.#operations);
    this.#researchHost.dispose();
    this.#workflowHost.dispose();
    await this.#browser.dispose();
  }

  #track(operation: Promise<void>): void {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation));
  }

  async #yieldSupervision(_sessionId: string): Promise<void> {
    // 前台普通对话不抢占独立协调会话。只有显式工作流命令才停止后台操作。
  }

  #drainSupervision(sessionId: string, workflowId?: string): void {
    if (this.#disposed) return;
    // Host 已给出精确身份的事件直接领取，避免额外 list 失败吞掉终态唤醒。
    // 领取仍由 Host 检查批准/暂停/未知状态，重复通知由协调器去重。
    if (workflowId) {
      this.#coordinator.wake(workflowId);
      return;
    }
    this.#track(
      this.#workflowHost
        .list(sessionId, this.#operationAbort.signal)
        .then((workflows) => {
          for (const workflow of workflows)
            if (workflow.status === "approved") this.#coordinator.wake(workflow.plan.workflowId);
        })
        .catch(() => {}),
    );
  }

  #loop(sessionId: string): VoiceLoopPort {
    const existing = this.#sessionLoops.get(sessionId);
    if (existing) return existing;
    const loop = this.#createVoiceLoop((event) => {
      // 不活跃会话的迟到事件不得贴上当前会话身份；轮次内代际仍由 VoiceLoop 校验。
      if (
        this.#sessionLoops.get(sessionId) === loop &&
        this.#activeSessionId === sessionId &&
        this.#activeRequestId
      ) {
        this.#emitVoice(this.#activeRequestId, event);
      }
    }, sessionId);
    this.#sessionLoops.set(sessionId, loop);
    return loop;
  }

  #requireTurn(requestId: RequestId): BufferedVoiceTurn {
    const turn = this.#turns.get(requestId);
    if (!turn) {
      throw new ProtocolValidationError(`voice turn is not open: ${requestId}`, "invalid_state");
    }
    return turn;
  }

  #emitVoice(requestId: RequestId, event: VoiceLoopEvent): void {
    this.#emitEnvelope(
      createVoiceEvent(
        requestId,
        event.kind,
        (event.kind.startsWith("voice.")
          ? {
              ...event.payload,
              sessionId: this.#activeSessionId,
              taskId: this.#activeTaskId,
            }
          : event.payload) as JsonValue,
      ),
    );
  }
}

function createConfiguredVoiceLoop(
  environment: NodeJS.ProcessEnv,
  emit: (event: VoiceLoopEvent) => void,
  browser: BrowserService,
  researchHost: ResearchHost,
  workflowHost: WorkflowHost,
  sessionId: string,
  collaboration: CollaborationService,
): VoiceLoop {
  const fixtureTranscript = environment.SEMI_OS_VOICE_FIXTURE_TRANSCRIPT?.trim();
  // 按用户体验反馈切换默认 ASR；保留显式 Qwen 回退，不混用两家的参数。
  const sttMode = environment.SEMI_OS_STT_PROVIDER?.trim() || "fun";
  const apiKey = environment.DASHSCOPE_API_KEY?.trim();
  if (!fixtureTranscript && !apiKey) {
    throw new Error(
      "voice provider is not configured; set DASHSCOPE_API_KEY in .env or SEMI_OS_VOICE_FIXTURE_TRANSCRIPT",
    );
  }
  const websocketUrl = environment.SEMI_OS_DASHSCOPE_WEBSOCKET_URL?.trim();
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
          ? await browser.policyEvidence(
              String(input.pageId),
              Number(input.version),
              String(input.ref),
              effectiveSignal,
            )
          : undefined;
        await researchHost.authorize(
          {
            taskId,
            toolName: tool.name,
            riskLevel: tool.riskLevel,
            inputDigest,
            approvalId,
            inputJson: JSON.stringify(input),
            evidence,
            sessionId,
          },
          effectiveSignal,
        );
        if (tool.riskLevel === "read" || tool.riskLevel === "local_write") return "auto";
        approvals.set(`${taskId}:${inputDigest}`, {
          approvalId,
          payloadDigest: inputDigest,
          approvedAtMs: Date.now(),
        });
        return "approved";
      } catch {
        return "rejected";
      }
    },
    approvalBinding: (taskId, input) => {
      const key = `${taskId}:${digestToolInput(input)}`;
      const binding = approvals.get(key);
      approvals.delete(key);
      return binding;
    },
    model: resolveCloudLlmModel(readCloudLlmConfig(environment)),
    additionalSkillPaths: [
      fileURLToPath(new URL("../../skills/research", import.meta.url)),
      fileURLToPath(new URL("../../skills/collaboration", import.meta.url)),
    ],
  });
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(browser, researchHost));
  registry.registerAll(createWorkflowTools(workflowHost, sessionId, collaboration));
  loop = new VoiceLoop({
    runtime,
    tools: registry.activeTools({
      platform: process.platform,
      capabilities: new Map([
        ["browser", { key: "browser", status: "available", observedAtMs: Date.now() }],
        ["collaboration", { key: "collaboration", status: "available", observedAtMs: Date.now() }],
      ]),
      workspaceAvailable: true,
      runtimeHealthy: true,
    }),
    saveReport: (report, signal) => researchHost.report(report, signal),
    explicitSpeech: true,
    stt: fixtureTranscript
      ? new FakeSttProvider(fixtureTranscript)
      : new DashScopeSttProvider({
          apiKey: apiKey!,
          websocketUrl,
          model:
            sttMode === "fun"
              ? environment.SEMI_OS_FUN_STT_MODEL?.trim() || "fun-asr-realtime"
              : environment.SEMI_OS_STT_MODEL?.trim(),
          mode: sttMode === "fun" ? "fun" : "qwen",
          nearfield: environment.SEMI_OS_STT_NEARFIELD !== "false",
          languageHints: (environment.SEMI_OS_STT_LANGUAGES ?? "zh,en")
            .split(",")
            .map((text) => text.trim())
            .filter(Boolean),
          vocabulary: (environment.SEMI_OS_STT_HOTWORDS ?? "Semi-OS,Pi,Codex,Claude Code,飞书")
            .split(",")
            .map((text) => text.trim())
            .filter(Boolean),
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
