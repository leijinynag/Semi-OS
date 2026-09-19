import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationRecord } from "@semi-os/shared";
import {
  ToolRegistry,
  isVerifiedSuccess,
  type ToolDefinition,
  type ToolExecutionReceipt,
} from "@semi-os/tool-sdk";
import { ActiveToolCoordinator } from "./active-tools.ts";
import { FakeAgentRuntime } from "./fake-runtime.ts";

const passed: VerificationRecord = {
  status: "passed",
  method: "fixture",
  summary: "page title matched",
  evidence: [{ kind: "fixture", reference: "page:title" }],
};

function fixtureTool(
  name: string,
  requiredCapabilities: readonly string[],
): ToolDefinition {
  return {
    name,
    description: `Fixture ${name}`,
    riskLevel: "read",
    inputSchema: { type: "object" },
    requiredCapabilities,
    async execute(input) {
      return { output: input, outputSummary: `${name} executed` };
    },
    async verify() {
      return passed;
    },
  };
}

test("filters unavailable tools and runs a verified fake-runtime turn", async () => {
  const registry = new ToolRegistry();
  registry.registerAll([
    fixtureTool("browser_open", ["browser.playwright"]),
    fixtureTool("desktop_click", ["permission.accessibility"]),
  ]);
  const runtime = new FakeAgentRuntime({
    script: [{ toolName: "browser_open", input: { url: "https://example.com" } }],
    now: (() => {
      let now = 100;
      return () => now++;
    })(),
  });
  const coordinator = new ActiveToolCoordinator(registry, runtime);
  const receipts: ToolExecutionReceipt[] = [];
  runtime.subscribe((event) => {
    if (event.kind === "tool.completed") {
      receipts.push(event.receipt);
    }
  });

  await runtime.startSession({
    sessionId: "session_fixture",
    cwd: "/tmp/semi-os-fixture",
    tools: registry.list(),
  });
  const snapshot = await coordinator.apply({
    platform: "darwin",
    capabilities: new Map([
      [
        "browser.playwright",
        { key: "browser.playwright", status: "available", observedAtMs: 1 },
      ],
      [
        "permission.accessibility",
        {
          key: "permission.accessibility",
          status: "unavailable",
          observedAtMs: 1,
        },
      ],
    ]),
    workspaceAvailable: true,
    runtimeHealthy: true,
  });

  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["browser_open"]);
  assert.deepEqual(
    snapshot.availability.find((entry) => entry.tool.name === "desktop_click")
      ?.reasons,
    ["capability_unavailable:permission.accessibility"],
  );

  await runtime.prompt({ taskId: "task_fixture", text: "Open the fixture" });
  assert.equal(receipts.length, 1);
  assert.equal(isVerifiedSuccess(receipts[0]!), true);
  assert.equal((await runtime.checkpoint()).sequence, 1);
});

test("fake runtime publishes an exception receipt before propagating failure", async () => {
  const runtime = new FakeAgentRuntime({
    script: [{ toolName: "local_write", input: { path: "notes.txt" } }],
  });
  const receipts: ToolExecutionReceipt[] = [];
  runtime.subscribe((event) => {
    if (event.kind === "tool.completed") {
      receipts.push(event.receipt);
    }
  });
  await runtime.startSession({
    sessionId: "session_fixture",
    cwd: "/tmp/semi-os-fixture",
    tools: [
      {
        ...fixtureTool("local_write", []),
        riskLevel: "local_write",
        async execute() {
          throw new Error("disk result is uncertain");
        },
      },
    ],
  });

  await assert.rejects(
    runtime.prompt({ taskId: "task_fixture", text: "write notes" }),
    /disk result is uncertain/,
  );
  assert.equal(receipts[0]?.status, "unknown");
  assert.equal(receipts[0]?.resultType, "unknown");
  assert.equal((await runtime.checkpoint()).sequence, 1);
});
