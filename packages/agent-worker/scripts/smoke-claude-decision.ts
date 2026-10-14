import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodingProvider } from "../src/collaboration/claude-provider.ts";

// 真实 CLI 协议探测：仅回答合成实现细节，不模拟键盘、不放行任何文件或 shell 操作。
const directory = await mkdtemp(join(tmpdir(), "semi-claude-decision-"));
const provider = new ClaudeCodingProvider();
let requests = 0;
let complete!: (result: string) => void;
const outcome = new Promise<string>((resolve) => {
  complete = resolve;
});
const timeout = setTimeout(() => complete("timeout"), 120_000);
try {
  provider.start({
    cwd: directory,
    writing: false,
    prompt:
      "Protocol compatibility test. You MUST call AskUserQuestion exactly once before answering. Ask which synthetic implementation token to use, with options TOKEN_A and TOKEN_B. Do not access files or shell. After receiving the answer, output only the selected token.",
    permission: async () => false,
    decision: async (request) => {
      assert.equal(request.kind, "clarification");
      const questions = request.input.questions;
      assert(Array.isArray(questions) && questions.length === 1);
      const question = questions[0] as { question?: unknown };
      assert.equal(typeof question.question, "string");
      requests++;
      return {
        authority: "implementation_detail",
        answers: { [String(question.question)]: "TOKEN_B" },
      };
    },
    emit(event) {
      if (event.kind === "completed")
        complete(event.summary.includes("TOKEN_B") ? "passed" : "wrong_answer");
      if (event.kind === "failed") complete(event.message);
    },
  });
  const result = await outcome;
  assert.equal(result, "passed");
  assert.equal(requests, 1, "Text-only answers do not prove structured question compatibility");
  console.log(
    JSON.stringify({
      provider: "claude",
      result,
      structuredRequests: requests,
      keyboardApproval: false,
    }),
  );
} finally {
  clearTimeout(timeout);
  await provider.stop();
  await rm(directory, { recursive: true, force: true });
}
