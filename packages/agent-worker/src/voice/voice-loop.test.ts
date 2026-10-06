import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEvent } from "../runtime.ts";
import { EventedAgentRuntime } from "../runtime.ts";
import { FakeSttProvider, FakeTtsProvider } from "./fake-providers.ts";
import { VoiceLoop, type VoiceLoopEvent } from "./voice-loop.ts";

class VoiceRuntimeFixture extends EventedAgentRuntime {
  readonly calls: string[] = [];
  sessionId?: string;
  paused = false;
  aborted = false;

  async startSession(input: Parameters<EventedAgentRuntime["startSession"]>[0]) {
    this.sessionId = input.sessionId;
    this.calls.push(`start:${input.sessionId}`);
    return { sessionId: input.sessionId };
  }

  async prompt(input: { taskId: string; text: string }) {
    this.calls.push(`prompt:${input.text}`);
  }

  async steer(input: { taskId: string; text: string }) {
    this.calls.push(`steer:${input.text}`);
  }

  async followUp(input: { taskId: string; text: string }) {
    this.calls.push(`follow-up:${input.text}`);
  }

  async pause() {
    this.paused = true;
    return {
      checkpoint: {
        sessionId: this.sessionId ?? "session_fixture",
        sequence: 0,
        data: {},
      },
      interrupted: true,
    };
  }

  async abort() {
    this.aborted = true;
  }

  async replaceTools() {}

  async checkpoint() {
    return {
      sessionId: this.sessionId ?? "session_fixture",
      sequence: 0,
      data: {},
    };
  }

  async dispose() {}

  emit(event: AgentRuntimeEvent) {
    this.publish(event);
  }
}

function turn(action: "prompt" | "steer" | "follow_up" = "prompt") {
  return {
    requestId: "req_voice_test" as never,
    sessionId: "session_voice",
    taskId: "task_voice",
    cwd: "/tmp/semi-os",
    mimeType: "audio/fake",
    action,
    chunks: [
      {
        sequence: 0,
        data: new Uint8Array([1, 2, 3]),
        mimeType: "audio/fake",
      },
    ],
  };
}

test("acknowledges before prompting and speaks the first complete sentence", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const events: VoiceLoopEvent[] = [];
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("整理会议纪要"),
    tts,
    emit: (event) => events.push(event),
  });

  await loop.run(turn());
  assert.deepEqual(runtime.calls, [
    "start:session_voice",
    "prompt:整理会议纪要",
  ]);
  assert.equal(tts.spoken[0], "好的，我来处理。");
  runtime.emit({
    kind: "assistant.text_delta",
    text: "第一句已经完成。第二句还没",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, ["好的，我来处理。", "第一句已经完成。"]);
  runtime.emit({ kind: "assistant.text_delta", text: "说完。" });
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, [
    "好的，我来处理。",
    "第一句已经完成。",
    "第二句还没说完。",
  ]);
  assert.ok(
    events.some((event) => event.kind === "voice.turn.completed"),
  );
});

test("keeps the same runtime session for follow-up and steering", async () => {
  const runtime = new VoiceRuntimeFixture();
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("继续补充"),
    tts: new FakeTtsProvider(),
    emit: () => {},
  });

  await loop.run(turn("prompt"));
  await loop.run(turn("follow_up"));
  await loop.run(turn("steer"));

  assert.equal(
    runtime.calls.filter((call) => call.startsWith("start:")).length,
    1,
  );
  assert.ok(runtime.calls.includes("follow-up:继续补充"));
  assert.ok(runtime.calls.includes("steer:继续补充"));
});

test("stops audio before pausing or cancelling the runtime", async () => {
  const runtime = new VoiceRuntimeFixture();
  const events: VoiceLoopEvent[] = [];
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("暂停"),
    tts: new FakeTtsProvider(),
    emit: (event) => events.push(event),
  });

  await loop.interrupt("task_voice", "pause");
  await loop.interrupt("task_voice", "cancel");

  assert.equal(runtime.paused, true);
  assert.equal(runtime.aborted, true);
  assert.deepEqual(
    events
      .filter((event) => event.kind === "voice.audio.stop")
      .map((event) => event.payload.reason),
    ["pause", "cancel"],
  );
});

test("does not prompt after cancellation while the session is starting", async () => {
  let releaseSession!: () => void;
  const sessionStarted = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const runtime = new VoiceRuntimeFixture();
  runtime.startSession = async (input) => {
    runtime.sessionId = input.sessionId;
    runtime.calls.push(`start:${input.sessionId}`);
    await sessionStarted;
    return { sessionId: input.sessionId };
  };
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("执行已经取消的操作"),
    tts: new FakeTtsProvider(),
    emit: () => {},
  });

  const running = loop.run(turn());
  await new Promise((resolve) => setImmediate(resolve));
  await loop.interrupt("task_voice", "cancel");
  releaseSession();
  await running;

  assert.equal(runtime.aborted, true);
  assert.equal(
    runtime.calls.some((call) => call.startsWith("prompt:")),
    false,
  );
});

test("ignores late runtime events after interruption", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const events: VoiceLoopEvent[] = [];
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("开始执行"),
    tts,
    emit: (event) => events.push(event),
  });

  await loop.run(turn());
  await loop.interrupt("task_voice", "pause");
  runtime.emit({ kind: "assistant.text_delta", text: "不应播出的旧回复。" });
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tts.spoken.includes("不应播出的旧回复。"), false);
  assert.equal(
    events
      .filter((event) => event.kind === "voice.state")
      .at(-1)?.payload.state,
    "interrupted",
  );
});
