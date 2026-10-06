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
import { VoiceLoop, type VoiceLoopEvent } from "./voice/voice-loop.ts";

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
}

export interface VoiceLoopPort {
  run(turn: Parameters<VoiceLoop["run"]>[0]): Promise<void>;
  interrupt(
    taskId: string,
    mode: "pause" | "cancel" | "steer",
    text?: string,
  ): Promise<void>;
  dispose(): Promise<void>;
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
  #activeRequestId?: RequestId;

  constructor(options: WorkerServiceOptions) {
    this.#pid = options.pid ?? process.pid;
    this.#environment = options.environment ?? process.env;
    this.#emitEnvelope = options.emit;
    this.#createVoiceLoop =
      options.createVoiceLoop ??
      ((emit) => createConfiguredVoiceLoop(this.#environment, emit));
  }

  async handle(request: RequestEnvelope): Promise<Envelope> {
    if (request.kind === "health.check") {
      return response(request, "health.ready", {
        worker: "semi-os-agent-worker",
        pid: this.#pid,
      });
    }

    const voiceRequest: VoiceRequestEnvelope = parseVoiceRequest(request);
    if (voiceRequest.kind === "voice.turn.start") {
      const payload = voiceRequest.payload;
      this.#turns.set(request.requestId, {
        requestId: request.requestId,
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        cwd: payload.cwd,
        mimeType: payload.mimeType,
        sampleRateHz: payload.sampleRateHz,
        action: payload.action ?? "prompt",
        chunks: [],
      });
      this.#emitVoice(request.requestId, {
        kind: "voice.state",
        payload: { state: "listening" },
      });
      return response(request, "voice.turn.started", { accepted: true });
    }

    if (voiceRequest.kind === "voice.audio.append") {
      const turn = this.#requireTurn(request.requestId);
      const expected = turn.chunks.length;
      if (voiceRequest.payload.sequence !== expected) {
        throw new ProtocolValidationError(
          `audio sequence mismatch: expected ${expected}`,
          "invalid_payload",
        );
      }
      turn.chunks.push({
        sequence: expected,
        data: Buffer.from(voiceRequest.payload.audioBase64, "base64"),
        mimeType: turn.mimeType,
        sampleRateHz: turn.sampleRateHz,
      });
      return response(request, "voice.audio.accepted", { sequence: expected });
    }

    if (voiceRequest.kind === "voice.turn.commit") {
      const turn = this.#requireTurn(request.requestId);
      if (voiceRequest.payload.lastSequence !== turn.chunks.length - 1) {
        throw new ProtocolValidationError(
          "commit does not match the last accepted audio sequence",
          "invalid_payload",
        );
      }
      this.#turns.delete(request.requestId);
      this.#activeRequestId = request.requestId;
      // 不 await 长任务，否则 stdin 消费会被阻塞，用户无法发出 pause/cancel/steer。
      void this.#loop()
        .run(turn)
        .catch((error) => {
          this.#emitVoice(request.requestId, {
            kind: "voice.error",
            payload: {
              code: "voice_loop_failed",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
          });
        });
      return response(request, "voice.turn.committed", { accepted: true });
    }

    const payload = voiceRequest.payload;
    const targetRequestId = this.#activeRequestId ?? request.requestId;
    await this.#loop().interrupt(
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
    await this.#voiceLoop?.dispose();
  }

  #loop(): VoiceLoopPort {
    this.#voiceLoop ??= this.#createVoiceLoop((event) => {
      if (this.#activeRequestId) {
        this.#emitVoice(this.#activeRequestId, event);
      }
    });
    return this.#voiceLoop;
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
        event.payload as JsonValue,
      ),
    );
  }
}

function createConfiguredVoiceLoop(
  environment: NodeJS.ProcessEnv,
  emit: (event: VoiceLoopEvent) => void,
): VoiceLoop {
  const fixtureTranscript =
    environment.SEMI_OS_VOICE_FIXTURE_TRANSCRIPT?.trim();
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
  const runtime = new PiAgentRuntime({
    model: resolveCloudLlmModel(readCloudLlmConfig(environment)),
  });
  return new VoiceLoop({
    runtime,
    stt: fixtureTranscript
      ? new FakeSttProvider(fixtureTranscript)
      : new DashScopeSttProvider({
          apiKey: apiKey!,
          websocketUrl,
          model: environment.SEMI_OS_STT_MODEL?.trim(),
        }),
    tts: fixtureTranscript
      ? new FakeTtsProvider()
      : new DashScopeTtsProvider({
          apiKey: apiKey!,
          websocketUrl,
          model: environment.SEMI_OS_TTS_MODEL?.trim(),
          voice: ttsVoice!,
        }),
    emit,
  });
}
