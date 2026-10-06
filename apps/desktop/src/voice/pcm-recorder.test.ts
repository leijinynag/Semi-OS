import assert from "node:assert/strict";
import test from "node:test";
import { floatToPcm16, resampleMono } from "./pcm-recorder.ts";

test("resamples browser audio to the requested sample count", () => {
  const input = new Float32Array(4_800).fill(0.25);
  const output = resampleMono(input, 48_000, 16_000);

  assert.equal(output.length, 1_600);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.0001));
});

test("serializes normalized samples as little-endian PCM16", () => {
  const output = floatToPcm16(new Float32Array([-1, 0, 1]));
  const view = new DataView(output.buffer);

  assert.equal(view.getInt16(0, true), -32_768);
  assert.equal(view.getInt16(2, true), 0);
  assert.equal(view.getInt16(4, true), 32_767);
});
