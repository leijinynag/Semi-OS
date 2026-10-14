import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventedAgentRuntime } from "../runtime.ts";
import { WorkflowCoordinator } from "./coordinator.ts";
import { parseWorkflowPlan, type JsonValue } from "@semi-os/protocol";

const plan = parseWorkflowPlan({
  workflowId: "workflow",
  sessionId: "session",
  version: 1,
  intentVersion: 1,
  title: "test",
  goal: "test",
  scope: ["src"],
  acceptance: ["tests"],
  repository: "/tmp/source",
  authorizedActions: ["read"],
  workItems: [
    {
      workItemId: "a",
      title: "a",
      objective: "a",
      role: "planning",
      provider: "pi",
      dependencies: [],
      outputs: ["plan"],
      acceptance: ["review"],
    },
  ],
});
class Runtime extends EventedAgentRuntime {
  session = "";
  prompts = 0;
  failure = false;
  async startSession(input: Parameters<EventedAgentRuntime["startSession"]>[0]) {
    this.session = input.sessionId;
    return { sessionId: this.session };
  }
  async prompt() {
    this.prompts++;
    if (this.failure) this.publish({ kind: "runtime.error", message: "unavailable" });
  }
  async steer() {}
  async followUp() {}
  async pause() {
    return { checkpoint: await this.checkpoint(), interrupted: true };
  }
  async abort() {}
  async replaceTools() {}
  async checkpoint() {
    return { sessionId: this.session, sequence: 1, data: {} };
  }
  async dispose() {}
}
test("durable batches run in an independent Pi session and empty claims do not poll the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-coordinator-"));
  const runtime = new Runtime();
  let consumed = false;
  let claims = 0;
  const coordinator = new WorkflowCoordinator({
    directory,
    runtime: () => runtime,
    tools: () => [],
    host: {
      request: async (operation): Promise<JsonValue> => {
        if (operation === "coordinator.claim") {
          claims++;
          return consumed
            ? { claimed: false }
            : {
                claimed: true,
                sequence: 1,
                checkpoint: null,
                snapshot: {
                  plan: JSON.parse(JSON.stringify(plan)),
                  digest: `sha256:${"a".repeat(64)}`,
                  status: "approved",
                  runs: [],
                  events: [],
                },
                events: [],
              };
        }
        if (operation === "coordinator.finish") consumed = true;
        return null;
      },
    },
  });
  try {
    coordinator.wake("workflow");
    coordinator.wake("workflow");
    await coordinator.settled("workflow");
    assert.equal(runtime.session, "coordinator_workflow");
    assert.equal(runtime.prompts, 1);
    assert.equal(claims, 2);
  } finally {
    await coordinator.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
test("only transport claims retry; a failed model is not replayed and leaves a needs-user receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-coordinator-"));
  const runtime = new Runtime();
  runtime.failure = true;
  let claims = 0;
  let failed = false;
  const requestIds: unknown[] = [];
  const coordinator = new WorkflowCoordinator({
    directory,
    runtime: () => runtime,
    tools: () => [],
    retryDelays: [0, 0, 0],
    host: {
      request: async (operation, _value, _signal, requestId): Promise<JsonValue> => {
        if (operation === "coordinator.claim") {
          requestIds.push(requestId);
          if (++claims < 3) throw new Error("transport unavailable");
          return {
            claimed: true,
            sequence: 1,
            checkpoint: null,
            snapshot: {
              plan: JSON.parse(JSON.stringify(plan)),
              digest: `sha256:${"a".repeat(64)}`,
              status: "approved",
              runs: [],
              events: [],
            },
            events: [],
          };
        }
        if (operation === "coordinator.fail") failed = true;
        return null;
      },
    },
  });
  try {
    coordinator.wake("workflow");
    await coordinator.settled("workflow");
    assert.equal(claims, 3);
    assert.equal(new Set(requestIds).size, 1);
    assert.equal(typeof requestIds[0], "string");
    assert.equal(runtime.prompts, 1);
    assert.equal(failed, true);
  } finally {
    await coordinator.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exhausted claim retries leave a visible reconciliation state without starting Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-coordinator-"));
  const runtime = new Runtime();
  let claims = 0;
  let unavailable = false;
  const coordinator = new WorkflowCoordinator({
    directory,
    runtime: () => runtime,
    tools: () => [],
    retryDelays: [0, 0, 0],
    host: {
      request: async (operation): Promise<JsonValue> => {
        if (operation === "coordinator.claim") {
          claims++;
          throw new Error("transport unavailable");
        }
        if (operation === "coordinator.unavailable") unavailable = true;
        return null;
      },
    },
  });
  try {
    coordinator.wake("workflow");
    await coordinator.settled("workflow");
    assert.equal(claims, 4);
    assert.equal(runtime.prompts, 0);
    assert.equal(unavailable, true);
  } finally {
    await coordinator.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
