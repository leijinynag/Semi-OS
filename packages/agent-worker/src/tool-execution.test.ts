import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationRecord } from "@semi-os/shared";
import type { ToolDefinition } from "@semi-os/tool-sdk";
import { executeProductTool, ToolExecutionError } from "./tool-execution.ts";

const verification: VerificationRecord = {
  status: "passed",
  method: "fixture",
  summary: "verified",
  evidence: [{ kind: "fixture", reference: "fixture:tool" }],
};

function tool(
  contract?: NonNullable<ToolDefinition["contract"]>,
  execute: ToolDefinition["execute"] = async () => ({
    output: { ok: true },
    outputSummary: "changed",
  }),
): ToolDefinition {
  return {
    name: "fixture_tool",
    description: "fixture",
    riskLevel: "local_write",
    contract,
    inputSchema: { type: "object" },
    requiredCapabilities: [],
    execute,
    verify: async () => verification,
  };
}

function input(toolDefinition: ToolDefinition, policyDecision: "auto" | "approved") {
  return {
    tool: toolDefinition,
    input: {},
    identity: {
      taskId: "task_fixture",
      attemptId: "attempt_fixture",
      attemptNumber: 1,
      idempotencyKey: "idem_fixture",
    },
    signal: new AbortController().signal,
    policyDecision,
    now: () => 10,
  } as const;
}

test("irreversible tools require Host approval even when policy says auto", async () => {
  let executions = 0;
  await assert.rejects(
    executeProductTool(
      input(
        tool(
          {
            mutation: { kind: "external", atomic: false },
            reversibility: "irreversible",
            verification: { required: true, method: "tool" },
          },
          async () => {
            executions += 1;
            return { output: {}, outputSummary: "must not run" };
          },
        ),
        "auto",
      ),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.receipt.status === "needs_user",
  );
  assert.equal(executions, 0);
});

test("approved irreversible tools execute and require verification", async () => {
  const executed = await executeProductTool(
    input(
      tool({
        mutation: { kind: "external", atomic: true },
        reversibility: "irreversible",
        verification: { required: true, method: "tool" },
        reconciliation: "required",
      }),
      "approved",
    ),
  );
  assert.equal(executed.receipt.status, "succeeded");
  assert.equal(executed.receipt.verification?.status, "passed");
});

test("a mutating tool that declares required verification but no method becomes unknown", async () => {
  let verified = false;
  await assert.rejects(
    executeProductTool(
      input(
        tool(
          {
            mutation: { kind: "workspace", atomic: true },
            verification: { required: true, method: "none" },
          },
          async () => ({ output: {}, outputSummary: "written" }),
        ),
        "auto",
      ),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.receipt.status === "unknown" &&
      error.receipt.resultType === "unknown",
  );
  assert.equal(verified, false);
});

test("a legacy mutating tool without a contract cannot be marked successful", async () => {
  await assert.rejects(
    executeProductTool(
      input(
        tool(undefined, async () => ({ output: {}, outputSummary: "written" })),
        "auto",
      ),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.receipt.status === "unknown" &&
      error.receipt.resultType === "unknown" &&
      error.receipt.verification?.status === "inconclusive",
  );
});

test("unknown results are handed back as reconciliation work, not retried by the executor", async () => {
  let executions = 0;
  const definition = tool(
    {
      mutation: { kind: "external", atomic: false },
      verification: { required: true, method: "tool" },
      reconciliation: "required",
    },
    async () => {
      executions += 1;
      throw new Error("transport ended after provider accepted the request");
    },
  );
  await assert.rejects(
    executeProductTool(input(definition, "approved")),
    (error: unknown) => error instanceof ToolExecutionError && error.receipt.status === "unknown",
  );
  assert.equal(executions, 1);
});
