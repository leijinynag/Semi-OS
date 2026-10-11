import assert from "node:assert/strict";
import test from "node:test";
import { spokenPrefix, validateWords } from "./speech-sync.ts";

test("reveals by actual word position and falls back for incomplete timestamps", () => {
  const text = "你好。";
  const words = validateWords([
    { text: "你", startMs: 120, endMs: 240 },
    { text: "好", startMs: 240, endMs: 400 },
  ], text);
  assert.ok(words);
  assert.equal(spokenPrefix(text, words, 0), "");
  assert.equal(spokenPrefix(text, words, 130), "你");
  assert.equal(spokenPrefix(text, words, 260), "你好");
  assert.equal(validateWords([{ text: "你", startMs: 0, endMs: 100 }], text), undefined);
  assert.equal(spokenPrefix(text, undefined, 0), text);
});

test("rejects nonmonotonic, infinite, and unrelated timestamps", () => {
  assert.equal(validateWords([{ text: "你", startMs: 100, endMs: 50 }], "你"), undefined);
  assert.equal(validateWords([{ text: "你", startMs: 0, endMs: Infinity }], "你"), undefined);
  assert.equal(validateWords([{ text: "他", startMs: 0, endMs: 50 }], "你"), undefined);
});
