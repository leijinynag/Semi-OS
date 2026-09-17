import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedSuccess, type ToolExecutionReceipt } from "./receipt.ts";

const receipt: ToolExecutionReceipt = {
  attemptId: "attempt_01",
  taskId: "task_01",
  toolName: "browser_open",
  idempotencyKey: "open:example",
  attemptNumber: 1,
  status: "succeeded",
  riskLevel: "read",
  inputSummary: "打开已脱敏 URL",
  inputDigest: "sha256:input",
  policyDecision: "auto",
  startedAtMs: 100,
  finishedAtMs: 120,
  durationMs: 20,
  resultType: "success",
  outputSummary: "页面已打开",
  verification: {
    status: "passed",
    method: "browser_readback",
    summary: "URL 与标题匹配",
    evidence: [{ kind: "browser_page", reference: "page_01" }],
    verifiedAtMs: 120,
  },
  artifacts: [],
};

test("accepts only success receipts with positive verification", () => {
  assert.equal(isVerifiedSuccess(receipt), true);
  assert.equal(
    isVerifiedSuccess({
      ...receipt,
      verification: { ...receipt.verification!, status: "inconclusive" },
    }),
    false,
  );
  assert.equal(isVerifiedSuccess({ ...receipt, verification: undefined }), false);
});
