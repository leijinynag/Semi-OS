import assert from "node:assert/strict";
import test from "node:test";
import type {
  Envelope,
  JsonValue,
  RequestEnvelope,
  RequestId,
} from "@semi-os/protocol";
import type { AgentRuntimeEvent } from "./runtime.ts";
import { EventedAgentRuntime } from "./runtime.ts";
import { FakeSttProvider, FakeTtsProvider } from "./voice/fake-providers.ts";
import { VoiceLoop } from "./voice/voice-loop.ts";
import { WorkerService, type VoiceLoopPort } from "./worker-service.ts";

function request(
  kind: string,
  payload: JsonValue,
): RequestEnvelope {
  return {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_worker_voice" as RequestId,
    kind,
    payload,
  };
}

test("buffers ordered audio and commits one voice turn", async () => {
  const emitted: Envelope[] = [];
  const turns: Array<Parameters<VoiceLoopPort["run"]>[0]> = [];
  const loop: VoiceLoopPort = {
    async run(turn) {
      turns.push(turn);
    },
    async interrupt() {},
    async dispose() {},
  };
  const service = new WorkerService({
    emit: (envelope) => emitted.push(envelope),
    createVoiceLoop: () => loop,
  });

  await service.handle(
    request("voice.turn.start", {
      sessionId: "session_voice",
      taskId: "task_voice",
      cwd: "/tmp/semi-os",
      mimeType: "audio/webm",
    }),
  );
  await service.handle(
    request("voice.audio.append", {
      sequence: 0,
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
    }),
  );
  await service.handle(
    request("voice.turn.commit", {
      lastSequence: 0,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(turns.length, 1);
  assert.deepEqual([...turns[0]!.chunks[0]!.data], [1, 2, 3]);
  assert.equal(turns[0]!.action, "prompt");
  assert.ok(
    emitted.some(
      (envelope) =>
        envelope.direction === "event" &&
        envelope.kind === "voice.state",
    ),
  );
});

test("rejects missing or out-of-order voice chunks", async () => {
  const service = new WorkerService({
    emit: () => {},
    createVoiceLoop: () => ({
      async run() {},
      async interrupt() {},
      async dispose() {},
    }),
  });
  await service.handle(
    request("voice.turn.start", {
      sessionId: "session_voice",
      taskId: "task_voice",
      cwd: "/tmp/semi-os",
      mimeType: "audio/webm",
    }),
  );

  await assert.rejects(
    service.handle(
      request("voice.audio.append", {
        sequence: 2,
        audioBase64: "AQID",
      }),
    ),
    /audio sequence mismatch/,
  );
});

test("routes interruption to the active voice loop before acknowledging it", async () => {
  const emitted: Envelope[] = [];
  const interrupts: Array<{
    taskId: string;
    mode: "pause" | "cancel" | "steer";
    text?: string;
  }> = [];
  const service = new WorkerService({
    emit: (envelope) => emitted.push(envelope),
    createVoiceLoop: () => ({
      async run() {},
      async interrupt(taskId, mode, text) {
        interrupts.push({ taskId, mode, text });
      },
      async dispose() {},
    }),
  });

  await service.handle(
    request("voice.turn.start", {
      sessionId: "session_voice",
      taskId: "task_voice",
      cwd: "/tmp/semi-os",
      mimeType: "audio/webm",
    }),
  );
  await service.handle(
    request("voice.turn.commit", {
      lastSequence: -1,
    }),
  );
  const response = await service.handle(
    request("voice.interrupt", {
      taskId: "task_voice",
      mode: "steer",
      text: "先停一下，改成整理待办",
    }),
  );

  assert.deepEqual(interrupts, [
    {
      taskId: "task_voice",
      mode: "steer",
      text: "先停一下，改成整理待办",
    },
  ]);
  assert.equal(response.kind, "voice.interrupt.accepted");
  assert.ok(
    emitted.some(
      (envelope) =>
        envelope.direction === "event" &&
        envelope.kind === "voice.state" &&
        envelope.requestId === "req_worker_voice",
    ),
  );
});

class ClosedLoopRuntimeFixture extends EventedAgentRuntime {
  readonly prompts: string[] = [];
  readonly sessions: string[] = [];

  async startSession(input: Parameters<EventedAgentRuntime["startSession"]>[0]) {
    this.sessions.push(input.sessionId);
    return { sessionId: input.sessionId };
  }

  async prompt(input: { taskId: string; text: string }) {
    this.prompts.push(input.text);
    this.publish({
      kind: "assistant.text_delta",
      text: "资料已经整理完成。这里是摘要。",
    });
    this.publish({ kind: "turn.completed", taskId: input.taskId });
  }

  async steer() {}
  async followUp() {}
  async pause() {
    return {
      checkpoint: {
        sessionId: this.sessions[0] ?? "session_voice",
        sequence: 0,
        data: {},
      },
      interrupted: false,
    };
  }
  async abort() {}
  async replaceTools() {}
  async checkpoint() {
    return {
      sessionId: this.sessions[0] ?? "session_voice",
      sequence: 0,
      data: {},
    };
  }
  async dispose() {}

  emit(event: AgentRuntimeEvent) {
    this.publish(event);
  }
}

test("runs the fake audio acceptance loop through the worker boundary", async () => {
  const emitted: Envelope[] = [];
  const runtime = new ClosedLoopRuntimeFixture();
  const tts = new FakeTtsProvider();
  const service = new WorkerService({
    emit: (envelope) => emitted.push(envelope),
    createVoiceLoop: (emit) =>
      new VoiceLoop({
        runtime,
        stt: new FakeSttProvider("搜索并整理这份资料"),
        tts,
        emit,
      }),
  });

  await service.handle(
    request("voice.turn.start", {
      sessionId: "session_voice",
      taskId: "task_voice",
      cwd: "/tmp/semi-os",
      mimeType: "audio/fake",
    }),
  );
  await service.handle(
    request("voice.audio.append", {
      sequence: 0,
      audioBase64: Buffer.from("fixture audio").toString("base64"),
    }),
  );
  await service.handle(
    request("voice.turn.commit", {
      lastSequence: 0,
    }),
  );

  await waitFor(() =>
    emitted.some(
      (envelope) =>
        envelope.direction === "event" &&
        envelope.kind === "voice.turn.completed",
    ),
  );

  assert.deepEqual(runtime.sessions, ["session_voice"]);
  assert.deepEqual(runtime.prompts, ["搜索并整理这份资料"]);
  assert.deepEqual(tts.spoken, [
    "好的，我来处理。",
    "资料已经整理完成。",
    "这里是摘要。",
  ]);
  assert.ok(
    emitted.some(
      (envelope) =>
        envelope.direction === "event" &&
        envelope.kind === "voice.transcript.final",
    ),
  );
  assert.ok(
    emitted.some(
      (envelope) =>
        envelope.direction === "event" &&
        envelope.kind === "voice.audio.chunk",
    ),
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for worker voice event");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
