import assert from "node:assert/strict";
import test from "node:test";
import { envelopeLevel, pcmEnvelope, smoothLevel } from "./pcm-envelope.ts";
import { floatToPcm16 } from "./pcm-recorder.ts";

test("PCM envelope follows silence and accents across odd byte boundaries", () => {
  const samples = Float32Array.from({ length: 1600 }, (_, i) =>
    i < 320 || i >= 960 ? 0 : i < 640 ? 0.05 : 0.2,
  );
  const pcm = floatToPcm16(samples);
  const envelope = pcmEnvelope(
    [pcm.subarray(0, 13), pcm.subarray(13, 491), pcm.subarray(491)],
    16000,
  );
  assert.equal(envelope.levels.length, 5);
  assert.equal(envelopeLevel(envelope, 0), 0);
  assert.ok(Math.abs(envelopeLevel(envelope, 0.025) - 0.2) < 0.001);
  assert.ok(Math.abs(envelopeLevel(envelope, 0.045) - 0.8) < 0.001);
  assert.equal(envelopeLevel(envelope, 0.065), 0);
  assert.equal(envelopeLevel(envelope, 2), 0);
  assert.equal(envelopeLevel(undefined, 0), 0);
  assert.throws(() => pcmEnvelope([Uint8Array.of(1)]));
  assert.throws(() => pcmEnvelope([], 0));
});

test("attack is faster than release and stalled frames cannot cause a jump", () => {
  const attack = smoothLevel(0, 1, 0.02);
  const decay = 1 - smoothLevel(1, 0, 0.02);
  assert.ok(attack > decay);
  assert.equal(smoothLevel(0.5, 1, 0), 0.5);
  assert.equal(smoothLevel(0, 1, 10), smoothLevel(0, 1, 0.1));
});
