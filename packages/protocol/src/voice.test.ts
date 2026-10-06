import assert from "node:assert/strict";
import test from "node:test";
import type { RequestId } from "@semi-os/shared";
import type { RequestEnvelope } from "./envelope.ts";
import { parseVoiceRequest } from "./voice.ts";

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
