import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEvent } from "../runtime.ts";
import { EventedAgentRuntime } from "../runtime.ts";
import { FakeSttProvider, FakeTtsProvider } from "./fake-providers.ts";
import { VoiceLoop, type VoiceLoopEvent } from "./voice-loop.ts";
import type { SttProvider } from "./stt.ts";
import type { TtsProvider } from "./tts.ts";

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

test("missing speech markers preserve only the final post-tool text", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const events: VoiceLoopEvent[] = [];
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("查资料"),
    tts,
    explicitSpeech: true,
    emit: (event) => events.push(event),
  });
  await loop.run(turn());
  runtime.emit({ kind: "assistant.text_delta", text: "我先查看工具。" });
  runtime.emit({ kind: "tool.requested", callId: "call_fixture", toolName: "read", input: {} });
  runtime.emit({ kind: "assistant.text_delta", text: "## 结论\n资料已整理。" });
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));
  const answer = events.find((event) => event.kind === "voice.answer");
  assert.equal(answer?.kind === "voice.answer" && answer.payload.report, "## 结论\n资料已整理。");
  assert.deepEqual(tts.spoken, ["结论 资料已整理。"]);
  assert.equal(
    events.some(
      (event) => event.kind === "voice.error" && event.payload.code === "speech_marker_missing",
    ),
    false,
  );
  await loop.dispose();
});

test("empty transcription reports a retryable input error without prompting Pi", async () => {
  const runtime = new VoiceRuntimeFixture();
  const stt: SttProvider = {
    async *transcribe() {
      yield { kind: "stt.silence" };
    },
  };
  const events: VoiceLoopEvent[] = [];
  const loop = new VoiceLoop({
    runtime,
    stt,
    tts: new FakeTtsProvider(),
    emit: (event) => events.push(event),
  });
  await loop.run(turn());
  assert.equal(runtime.calls.length, 0);
  assert.ok(
    events.some((event) => event.kind === "voice.error" && event.payload.code === "stt_empty"),
  );
  await loop.dispose();
});

test("does not acknowledge every input and speaks the first complete sentence", async () => {
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
  assert.deepEqual(runtime.calls, ["start:session_voice", "prompt:整理会议纪要"]);
  assert.equal(tts.spoken.length, 0);
  runtime.emit({
    kind: "assistant.text_delta",
    text: "第一句已经完成。第二句还没",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, ["第一句已经完成。"]);
  runtime.emit({ kind: "assistant.text_delta", text: "说完。" });
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, ["第一句已经完成。", "第二句还没说完。"]);
  assert.ok(events.some((event) => event.kind === "voice.turn.completed"));
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

  assert.equal(runtime.calls.filter((call) => call.startsWith("start:")).length, 1);
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
    events.filter((event) => event.kind === "voice.state").at(-1)?.payload.state,
    "interrupted",
  );
});

test("streaming report markers are not spoken and Host persistence precedes completion", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const events: VoiceLoopEvent[] = [];
  let resolveSave!: () => void;
  const saving = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("资料调研"),
    tts,
    emit: (event) => events.push(event),
    saveReport: async () => saving,
  });
  await loop.run(turn());
  for (const text of [
    "主要结论。",
    "[source_",
    "abc:q1]",
    "``",
    "`research-report\n",
    '{"summary":"结论","claims":[],"limitations":[]}',
    "```",
  ]) {
    runtime.emit({ kind: "assistant.text_delta", text });
  }
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, ["主要结论。"]);
  assert.equal(
    events.some((event) => event.kind === "voice.turn.completed"),
    false,
  );
  resolveSave();
  await new Promise((resolve) => setImmediate(resolve));
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.indexOf("research.report") < kinds.indexOf("voice.turn.completed"));
  await loop.dispose();
});

test("only explicit short speech is spoken across split markers", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("调研"),
    tts,
    explicitSpeech: true,
    emit: () => {},
  });
  await loop.run(turn());
  for (const text of [
    "我先分析资料。<spe",
    "ech>已查到两个来源。<",
    "/speech>详细文字不应该朗读。",
  ]) {
    runtime.emit({ kind: "assistant.text_delta", text });
  }
  runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tts.spoken, ["已查到两个来源。"]);
  await loop.dispose();
});

test("long explicit speech starts at a Chinese pause without reading the report or cancelled tail", async () => {
  const runtime = new VoiceRuntimeFixture();
  const tts = new FakeTtsProvider();
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("调研"),
    tts,
    explicitSpeech: true,
    emit: () => {},
  });
  try {
    await loop.run(turn());
    const clause = "我已经对比了这几个来源并整理好了主要结论，";
    for (const text of ["工具前过程不会播报。<spe", "ech>", clause.slice(0, -1)]) {
      runtime.emit({ kind: "assistant.text_delta", text });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tts.spoken, []);
    runtime.emit({ kind: "assistant.text_delta", text: "，[source_" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tts.spoken, [clause]);
    runtime.emit({ kind: "assistant.text_delta", text: "abc]补充结论。</spe" });
    runtime.emit({ kind: "assistant.text_delta", text: "ech>## 详细报告\n报告不应该朗读。" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tts.spoken, [clause, "补充结论。"]);
    await loop.interrupt("task_voice", "pause");
    runtime.emit({ kind: "assistant.text_delta", text: "<speech>旧轮次不会继续播报。</speech>" });
    runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(tts.spoken, [clause, "补充结论。"]);
  } finally {
    await loop.dispose();
  }
});

test("latency separates recognition tail, session, sentence and provider first audio", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const runtime = new VoiceRuntimeFixture();
  const events: VoiceLoopEvent[] = [];
  const stt: SttProvider = {
    async *transcribe({ audio }) {
      for await (const _chunk of audio) now = 100;
      now = 120;
      yield { kind: "stt.final", text: "你好" };
    },
  };
  runtime.startSession = async (input) => {
    now += 15;
    return { sessionId: input.sessionId };
  };
  runtime.prompt = async (input) => {
    now += 25;
    runtime.emit({ kind: "assistant.text_delta", text: "<speech>这是一句" });
    assert.equal(
      events.some((event) => event.kind === "voice.sentence"),
      false,
    );
    now += 40;
    runtime.emit({ kind: "assistant.text_delta", text: "完整回答。还有一句。" });
    runtime.emit({ kind: "turn.completed", taskId: input.taskId });
  };
  const tts: TtsProvider = {
    async *synthesize({ sentenceId }) {
      now += 30;
      yield { kind: "tts.first_audio_ready", sentenceId };
      yield { kind: "tts.first_audio_ready", sentenceId };
      now += 50;
      yield {
        kind: "tts.audio",
        sentenceId,
        sequence: 0,
        data: Uint8Array.of(1, 2),
        mimeType: "audio/fake",
      };
      yield { kind: "tts.completed", sentenceId };
    },
  };
  const loop = new VoiceLoop({
    runtime,
    stt,
    tts,
    explicitSpeech: true,
    emit: (event) => events.push(event),
  });
  try {
    await loop.run(turn());
    const timings = events
      .filter((event) => event.kind === "research.timing")
      .map((event) => event.payload);
    assert.deepEqual(timings, [
      { stage: "stt.total", durationMs: 120 },
      { stage: "stt.final", durationMs: 20 },
      { stage: "session.ready", durationMs: 15 },
      { stage: "model.first_delta", durationMs: 25 },
      { stage: "speech.first_sentence_ready", durationMs: 65 },
      { stage: "tts.answer.first_audio", durationMs: 30 },
      { stage: "tts.answer.completed", durationMs: 80 },
      { stage: "tts.answer.first_audio", durationMs: 30 },
      { stage: "tts.answer.completed", durationMs: 80 },
    ]);
    const chunks = events.filter((event) => event.kind === "voice.audio.chunk");
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((event) => event.payload.first));
  } finally {
    await loop.dispose();
  }
});

test("latency falls back to real audio without provider readiness and ignores stage speech", async () => {
  const runtime = new VoiceRuntimeFixture();
  const events: VoiceLoopEvent[] = [];
  const tts: TtsProvider = {
    async *synthesize({ sentenceId }) {
      yield {
        kind: "tts.audio",
        sentenceId,
        sequence: 0,
        data: Uint8Array.of(1, 2),
        mimeType: "audio/fake",
      };
      yield {
        kind: "tts.audio",
        sentenceId,
        sequence: 1,
        data: Uint8Array.of(3, 4),
        mimeType: "audio/fake",
      };
      yield { kind: "tts.completed", sentenceId };
    },
  };
  const loop = new VoiceLoop({
    runtime,
    stt: new FakeSttProvider("查资料"),
    tts,
    emit: (event) => events.push(event),
  });
  try {
    await loop.run(turn());
    runtime.emit({
      kind: "tool.requested",
      callId: "call_search",
      toolName: "browser_open",
      input: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      events.some(
        (event) =>
          event.kind === "research.timing" && event.payload.stage === "speech.first_sentence_ready",
      ),
      false,
    );
    runtime.emit({ kind: "assistant.text_delta", text: "结论已确认。" });
    runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
    await new Promise((resolve) => setImmediate(resolve));
    const timings = events.filter((event) => event.kind === "research.timing");
    assert.equal(
      timings.filter((event) => event.payload.stage === "speech.first_sentence_ready").length,
      1,
    );
    assert.equal(
      timings.filter((event) => event.payload.stage === "tts.answer.first_audio").length,
      1,
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === "voice.audio.chunk")
        .map((event) => event.payload.first),
      [true, false],
    );
    assert.equal(events.filter((event) => event.kind === "research.progress").length, 1);
    assert.equal(
      events.some((event) => event.kind === "voice.sentence" && event.payload.purpose === "stage"),
      false,
    );
  } finally {
    await loop.dispose();
  }
});

test("empty completion and runtime failure cannot silently complete a voice turn", async () => {
  for (const failure of ["empty", "runtime"] as const) {
    const runtime = new VoiceRuntimeFixture();
    const events: VoiceLoopEvent[] = [];
    const loop = new VoiceLoop({
      runtime,
      stt: new FakeSttProvider("星期几啊"),
      tts: new FakeTtsProvider(),
      emit: (event) => events.push(event),
    });
    try {
      await loop.run(turn());
      if (failure === "runtime") {
        runtime.emit({ kind: "runtime.error", message: "模型回复被中止，请重试。" });
      }
      runtime.emit({ kind: "turn.completed", taskId: "task_voice" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(events.some((event) => event.kind === "voice.error"));
      assert.equal(
        events.some((event) => event.kind === "voice.turn.completed"),
        false,
      );
      assert.equal(
        events.some((event) => event.kind === "voice.answer"),
        false,
      );
    } finally {
      await loop.dispose();
    }
  }
});
