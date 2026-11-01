import assert from "node:assert/strict";
import test from "node:test";
import { appendMemoryContext, VOICE_SYSTEM_PROMPT } from "./system-prompt.ts";

test("per-turn memory context is appended to the system prompt", () => {
  const prompt = appendMemoryContext(
    VOICE_SYSTEM_PROMPT,
    "[preference]\n语气\n活泼\n\n[compact_persona]\n身份：Semi 助手",
  );
  assert.ok(prompt.startsWith(VOICE_SYSTEM_PROMPT));
  assert.match(prompt, /语气\n活泼/);
  assert.match(prompt, /身份：Semi 助手/);
  assert.match(prompt, /系统材料/);
});

test("missing memory context does not perturb the base system prompt", () => {
  assert.equal(appendMemoryContext(VOICE_SYSTEM_PROMPT), VOICE_SYSTEM_PROMPT);
  assert.equal(appendMemoryContext(VOICE_SYSTEM_PROMPT, "  \n"), VOICE_SYSTEM_PROMPT);
});
