import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope, JsonValue, RequestEnvelope, RequestId } from "@semi-os/protocol";
import type { AgentRuntimeEvent } from "./runtime.ts";
import { EventedAgentRuntime } from "./runtime.ts";
import { FakeSttProvider, FakeTtsProvider } from "./voice/fake-providers.ts";
import { VoiceLoop, VoiceSessionMismatchError, type VoiceLoopEvent } from "./voice/voice-loop.ts";
import { WorkerService, type VoiceLoopPort } from "./worker-service.ts";

function request(kind: string, payload: JsonValue): RequestEnvelope {
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
      if ("text" in turn) throw new Error("expected audio turn");
      turns.push(turn);
      for await (const chunk of turn.audio!) turn.chunks.push(chunk);
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
  const turn = turns[0]!;
  assert.ok("chunks" in turn);
  assert.deepEqual([...turn.chunks[0]!.data], [1, 2, 3]);
  assert.equal(turns[0]!.action, "prompt");
  assert.ok(
    emitted.some((envelope) => envelope.direction === "event" && envelope.kind === "voice.state"),
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
      (envelope) => envelope.direction === "event" && envelope.kind === "voice.turn.completed",
    ),
  );

  assert.deepEqual(runtime.sessions, ["session_voice"]);
  assert.deepEqual(runtime.prompts, ["搜索并整理这份资料"]);
  assert.deepEqual(tts.spoken, ["资料已经整理完成。", "这里是摘要。"]);
  assert.ok(
    emitted.some(
      (envelope) => envelope.direction === "event" && envelope.kind === "voice.transcript.final",
    ),
  );
  assert.ok(
    emitted.some(
      (envelope) => envelope.direction === "event" && envelope.kind === "voice.audio.chunk",
    ),
  );
});

test("reloaded-page turns reuse the Host session and keep the same runtime", async () => {
  const emitted: Envelope[] = [];
  const runtime = new ClosedLoopRuntimeFixture();
  const service = new WorkerService({
    emit: (envelope) => emitted.push(envelope),
    createVoiceLoop: (emit) =>
      new VoiceLoop({
        runtime,
        stt: new FakeSttProvider("你好"),
        tts: new FakeTtsProvider(),
        emit,
      }),
  });
  try {
    for (const id of ["req_before_reload", "req_after_reload"] as RequestId[]) {
      await service.handle({
        ...request("voice.turn.start", {
          sessionId: "session_host",
          taskId: `task_${id}`,
          cwd: "/tmp/semi-os",
          mimeType: "audio/fake",
        }),
        requestId: id,
      });
      await service.handle({
        ...request("voice.turn.commit", { lastSequence: -1 }),
        requestId: id,
      });
      await waitFor(() =>
        emitted.some((event) => event.kind === "voice.turn.completed" && event.requestId === id),
      );
    }
    assert.deepEqual(runtime.sessions, ["session_host"]);
    assert.deepEqual(runtime.prompts, ["你好", "你好"]);
    assert.ok(!emitted.some((event) => event.kind === "voice.error"));
  } finally {
    await service.dispose();
  }
});

test("classifies session mismatch without exposing the internal exception", async () => {
  const emitted: Envelope[] = [];
  const service = new WorkerService({
    emit: (envelope) => emitted.push(envelope),
    createVoiceLoop: () => ({
      async run() {
        throw new VoiceSessionMismatchError();
      },
      async interrupt() {},
      async dispose() {},
    }),
  });
  try {
    await service.handle(
      request("voice.turn.start", {
        sessionId: "session_original",
        taskId: "task_voice",
        cwd: "/tmp/semi-os",
        mimeType: "audio/fake",
      }),
    );
    await service.handle(request("voice.turn.commit", { lastSequence: -1 }));
    await waitFor(() => emitted.some((event) => event.kind === "voice.error"));
    const error = emitted.find((event) => event.kind === "voice.error")!;
    assert.equal((error.payload as Record<string, unknown>).code, "voice_session_mismatch");
    assert.equal((error.payload as Record<string, unknown>).retryable, false);
    assert.ok(!JSON.stringify(error).includes("cannot switch"));
  } finally {
    await service.dispose();
  }
});

test("manual sessions isolate Pi context and reuse it when switching back", async () => {
  const emitted: Envelope[] = [];
  const runtimes: ClosedLoopRuntimeFixture[] = [];
  const service = new WorkerService({
    emit: (event) => emitted.push(event),
    createVoiceLoop: (emit) => {
      const runtime = new ClosedLoopRuntimeFixture();
      runtimes.push(runtime);
      return new VoiceLoop({
        runtime,
        emit,
        stt: new FakeSttProvider("你好"),
        tts: new FakeTtsProvider(),
      });
    },
  });
  try {
    for (const [index, sessionId] of ["session_a", "session_b", "session_a"].entries()) {
      const requestId = `req_session_${index}` as RequestId;
      await service.handle({
        ...request("voice.text.submit", {
          sessionId,
          taskId: `task_${index}`,
          cwd: "/tmp",
          text: `消息${index}`,
        }),
        requestId,
      });
      await waitFor(() =>
        emitted.some(
          (event) => event.kind === "voice.turn.completed" && event.requestId === requestId,
        ),
      );
    }
    assert.equal(runtimes.length, 2);
    assert.deepEqual(runtimes[0]!.sessions, ["session_a"]);
    assert.deepEqual(runtimes[0]!.prompts, ["消息0", "消息2"]);
    assert.deepEqual(runtimes[1]!.prompts, ["消息1"]);
  } finally {
    await service.dispose();
  }
});

test("inactive session events are ignored and all session loops are disposed once", async () => {
  const emitted: Envelope[] = [];
  const callbacks: Array<(event: VoiceLoopEvent) => void> = [];
  const disposed: number[] = [];
  const service = new WorkerService({
    emit: (event) => emitted.push(event),
    createVoiceLoop: (emit) => {
      const index = callbacks.length;
      callbacks.push(emit);
      disposed.push(0);
      return {
        async run() {},
        async interrupt() {},
        async dispose() {
          disposed[index]!++;
        },
      };
    },
  });
  for (const sessionId of ["session_a", "session_b"]) {
    await service.handle(
      request("voice.text.submit", {
        sessionId,
        taskId: `task_${sessionId}`,
        text: "你好",
        cwd: "/tmp",
      }),
    );
  }
  // 后台发现请求是独立协议事件；此测试只检查前台语音事件的会话归属。
  emitted.splice(0);
  callbacks[0]!({ kind: "voice.state", payload: { state: "speaking" } });
  assert.equal(emitted.length, 0);
  callbacks[1]!({ kind: "voice.state", payload: { state: "thinking" } });
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0]!.payload as Record<string, unknown>).sessionId, "session_b");
  await service.dispose();
  assert.deepEqual(disposed, [1, 1]);
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

test("session disposal is idempotent, drops late events and preserves other contexts", async () => {
  const emitted: Envelope[] = [];
  const callbacks: Array<(event: VoiceLoopEvent) => void> = [];
  const disposed: number[] = [];
  const service = new WorkerService({
    emit: (event) => emitted.push(event),
    createVoiceLoop: (emit) => {
      const index = callbacks.length;
      callbacks.push(emit);
      disposed.push(0);
      return {
        async run() {},
        async interrupt() {},
        async dispose() {
          disposed[index]!++;
          emit({ kind: "voice.state", payload: { state: "speaking" } });
        },
      };
    },
  });
  const submit = (sessionId: string) =>
    service.handle(
      request("voice.text.submit", {
        sessionId,
        taskId: `task_${sessionId}`,
        text: "你好",
        cwd: "/tmp",
      }),
    );
  try {
    await submit("a");
    await submit("b");
    await service.handle(request("voice.session.dispose", { sessionId: "a" }));
    await service.handle(request("voice.session.dispose", { sessionId: "a" }));
    await service.handle(request("voice.session.dispose", { sessionId: "unused" }));
    assert.deepEqual(disposed, [1, 0]);
    await submit("a");
    emitted.splice(0);
    callbacks[0]!({ kind: "voice.state", payload: { state: "speaking" } });
    assert.equal(emitted.length, 0);
    assert.equal(callbacks.length, 3);
    await service.handle(request("voice.session.dispose", { sessionId: "a" }));
    assert.equal(emitted.filter((event) => event.kind.startsWith("voice.")).length, 0);
    await submit("b");
    assert.equal(callbacks.length, 3);
  } finally {
    await service.dispose();
  }
  assert.deepEqual(disposed, [1, 1, 1]);
});

test("text skips STT but shares runtime session, answer events and TTS with audio", async () => {
  const emitted: Envelope[] = [];
  const runtime = new ClosedLoopRuntimeFixture();
  const tts = new FakeTtsProvider();
  let transcriptions = 0;
  const stt = new FakeSttProvider("语音后续问题");
  const service = new WorkerService({
    emit: (event) => emitted.push(event),
    createVoiceLoop: (emit) =>
      new VoiceLoop({
        runtime,
        tts,
        emit,
        stt: {
          async *transcribe(input) {
            transcriptions++;
            yield* stt.transcribe(input);
          },
        },
      }),
  });
  try {
    const response = await service.handle(
      request("voice.text.submit", {
        sessionId: "session_voice",
        taskId: "task_text",
        cwd: "/tmp/semi-os",
        text: "  帮我查资料  ",
      }),
    );
    assert.equal(response.kind, "voice.text.accepted");
    await waitFor(() => emitted.some((event) => event.kind === "voice.turn.completed"));
    assert.equal(transcriptions, 0);
    assert.deepEqual(runtime.prompts, ["帮我查资料"]);
    assert.deepEqual(tts.spoken, ["资料已经整理完成。", "这里是摘要。"]);
    assert.ok(emitted.some((event) => event.kind === "voice.audio.chunk"));
    assert.ok(
      !emitted.some(
        (event) =>
          event.kind === "voice.state" &&
          ["listening", "transcribing"].includes(
            String((event.payload as Record<string, unknown>).state),
          ),
      ),
    );
    const id = "req_voice_after_text" as RequestId;
    await service.handle({
      ...request("voice.turn.start", {
        sessionId: "session_voice",
        taskId: "task_next",
        cwd: "/tmp/semi-os",
        mimeType: "audio/fake",
      }),
      requestId: id,
    });
    await service.handle({ ...request("voice.turn.commit", { lastSequence: -1 }), requestId: id });
    await waitFor(() =>
      emitted.some((event) => event.kind === "voice.turn.completed" && event.requestId === id),
    );
    assert.equal(transcriptions, 1);
    assert.deepEqual(runtime.sessions, ["session_voice"]);
    assert.deepEqual(runtime.prompts, ["帮我查资料", "语音后续问题"]);
  } finally {
    await service.dispose();
  }
});

test("text interrupts an open recording before rebinding the active identity", async () => {
  const order: string[] = [];
  const service = new WorkerService({
    emit: () => {},
    createVoiceLoop: () => ({
      async run(turn) {
        order.push("text" in turn ? `text:${turn.taskId}` : `audio:${turn.taskId}`);
      },
      async interrupt(taskId) {
        order.push(`pause:${taskId}`);
      },
      async dispose() {},
    }),
  });
  try {
    await service.handle(
      request("voice.turn.start", {
        sessionId: "session_voice",
        taskId: "task_voice",
        cwd: "/tmp",
        mimeType: "audio/fake",
      }),
    );
    await service.handle(
      request("voice.text.submit", {
        sessionId: "session_voice",
        taskId: "task_text",
        cwd: "/tmp",
        text: "先停下",
      }),
    );
    assert.equal(order.at(-1), "text:task_text");
    await assert.rejects(
      service.handle(request("voice.audio.append", { sequence: 0, audioBase64: "AQID" })),
      /not open/,
    );
  } finally {
    await service.dispose();
  }
});

test("foreground chat does not use voice supervision or interrupt a background coordinator", async () => {
  let foreground = 0;
  let interruptions = 0;
  let supervised = 0;
  const operations: string[] = [];
  const service = new WorkerService({
    createVoiceLoop: () => ({
      async run() {
        foreground++;
      },
      async interrupt() {
        interruptions++;
      },
      async dispose() {},
      async supervise() {
        supervised++;
      },
    }),
    emit(envelope) {
      if (envelope.kind !== "workflow.request") return;
      const payload = envelope.payload as { operationId: string; operation: string };
      operations.push(payload.operation);
      queueMicrotask(() => {
        void service.handle(
          request("workflow.acknowledged", {
            operationId: payload.operationId,
            ok: true,
            value: payload.operation === "coordinator.claim" ? { claimed: false } : [],
          }),
        );
      });
    },
  });
  try {
    await service.handle(
      request("workflow.control", {
        workflowId: "workflow",
        sessionId: "session_fixture",
        action: "observe",
      }),
    );
    await service.handle(
      request("voice.text.submit", {
        sessionId: "session_fixture",
        taskId: "task_user",
        text: "查询进度",
        cwd: "/tmp",
      }),
    );
    await waitFor(() => foreground === 1);
    assert.equal(supervised, 0);
    assert.equal(interruptions, 0); // 普通聊天没有旧语音轮次，也不调用后台 Runtime。
    assert.ok(operations.includes("coordinator.claim"));
    assert.ok(operations.every((operation) => ["list", "coordinator.claim"].includes(operation)));
  } finally {
    await service.dispose();
  }
});

test("a targeted workflow notification wakes the coordinator without a fallible Session lookup", async () => {
  const operations: string[] = [];
  const service = new WorkerService({
    emit(envelope) {
      if (envelope.kind !== "workflow.request") return;
      const payload = envelope.payload as {
        operationId: string;
        operation: string;
        value: { workflowId: string };
      };
      operations.push(payload.operation);
      assert.equal(payload.operation, "coordinator.claim");
      assert.equal(payload.value.workflowId, "workflow_exact");
      queueMicrotask(() => {
        void service.handle(
          request("workflow.acknowledged", {
            operationId: payload.operationId,
            ok: true,
            value: { claimed: false },
          }),
        );
      });
    },
  });
  try {
    await service.handle(
      request("workflow.control", {
        workflowId: "workflow_exact",
        sessionId: "session_other",
        action: "observe",
      }),
    );
    await waitFor(() => operations.length === 1);
    assert.deepEqual(operations, ["coordinator.claim"]);
  } finally {
    await service.dispose();
  }
});
