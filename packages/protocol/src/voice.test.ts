import assert from "node:assert/strict";
import test from "node:test";
import type { RequestId } from "@semi-os/shared";
import type { JsonValue, RequestEnvelope } from "./envelope.ts";
import { createVoiceEvent, parseVoiceEvent, parseVoiceRequest } from "./voice.ts";

test("accepts an ordered audio append request", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_voice_append" as RequestId,
    kind: "voice.audio.append",
    payload: { sequence: 2, audioBase64: "AQID" },
  };

  assert.doesNotThrow(() => parseVoiceRequest(request));
});

test("validates sentence identity, bounded reports and timestamp ranges", () => {
  const sentence = createVoiceEvent("req_test" as RequestId, "voice.sentence", {
    sessionId: "session_test",
    taskId: "task_test",
    sentenceId: "answer_1",
    text: "你好。",
    purpose: "answer",
  });
  assert.doesNotThrow(() => parseVoiceEvent(sentence));
  assert.throws(() =>
    parseVoiceEvent({
      ...sentence,
      payload: { sentenceId: "answer_1", text: "你好。", purpose: "answer" },
    }),
  );
  assert.throws(() =>
    parseVoiceEvent({
      ...sentence,
      kind: "voice.timestamps",
      payload: {
        sessionId: "session_test",
        taskId: "task_test",
        sentenceId: "answer_1",
        words: [{ text: "你好", startMs: 100, endMs: 50 }],
      },
    }),
  );
});

test("accepts an empty recording commit", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_voice_empty" as RequestId,
    kind: "voice.turn.commit",
    payload: { lastSequence: -1 },
  };
  const parsed = parseVoiceRequest(request);

  assert.equal(parsed.kind, "voice.turn.commit");
  if (parsed.kind === "voice.turn.commit") {
    assert.equal(parsed.payload.lastSequence, -1);
  }
});

test("rejects an invalid interrupt mode", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_voice_interrupt" as RequestId,
    kind: "voice.interrupt",
    payload: { taskId: "task_voice", mode: "retry" },
  };

  assert.throws(() => parseVoiceRequest(request), /interrupt mode is invalid/);
});

test("validates direct text input without requiring audio metadata", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_text" as RequestId,
    kind: "voice.text.submit",
    payload: {
      sessionId: "session_text",
      taskId: "task_text",
      cwd: "/tmp",
      text: "查一下天气",
      action: "prompt",
    },
  };
  assert.doesNotThrow(() => parseVoiceRequest(request));
  const payload = request.payload as Record<string, string>;
  for (const text of [" \n", "a".repeat(64_001)]) {
    assert.throws(() => parseVoiceRequest({ ...request, payload: { ...payload, text } }));
  }
  assert.throws(() => parseVoiceRequest({ ...request, payload: { ...payload, action: "bypass" } }));
});

test("session disposal requires an explicit nonempty session identity", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_dispose" as RequestId,
    kind: "voice.session.dispose",
    payload: { sessionId: "session_a" },
  };
  assert.doesNotThrow(() => parseVoiceRequest(request));
  for (const payload of [{} as JsonValue, { sessionId: "" }, { sessionId: 1 }]) {
    assert.throws(() => parseVoiceRequest({ ...request, payload }));
  }
});
