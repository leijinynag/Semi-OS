import assert from "node:assert/strict";
import test from "node:test";
import { characterErrors, percentile, wavePcm } from "./benchmark.ts";

test("CER and latency percentiles keep numeric evidence separate from semantic correctness", () => {
  assert.deepEqual(characterErrors("你好 Pi。", "你好Py"), { characters: 4, errors: 1 });
  assert.deepEqual(characterErrors("三个", "3个"), { characters: 2, errors: 1 });
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([100, 3, 20, NaN], 0.5), 20);
  assert.equal(percentile([100, 3, 20], 0.95), 100);
});

test("WAV parser validates format and chunk boundaries instead of trusting a data marker", () => {
  const wav = Buffer.alloc(48);
  wav.write("RIFF");
  wav.writeUInt32LE(40, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  assert.equal(wavePcm(wav).length, 4);
  const stereo = Buffer.from(wav);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => wavePcm(stereo), /mono/);
  const broken = Buffer.from(wav);
  broken.writeUInt32LE(1000, 40);
  assert.throws(() => wavePcm(broken), /truncated/);
  assert.throws(() => wavePcm(wav.subarray(0, 47)), /invalid/);
});
