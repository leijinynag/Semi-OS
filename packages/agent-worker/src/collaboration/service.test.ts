import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationService } from "./service.ts";
import { parseWorkflowPlan, type AgentRun, type WorkflowSnapshot } from "@semi-os/protocol";
import type { ProviderStart, CodingProviderPort } from "./provider.ts";

function fixture(steer = true, healthTimeoutMs = 120_000) {
  const snapshot: WorkflowSnapshot = {
    plan: parseWorkflowPlan({
      workflowId: "workflow",
      sessionId: "session",
      version: 1,
      intentVersion: 1,
      title: "test",
      goal: "test",
      scope: ["src"],
      acceptance: ["tests"],
      repository: "/tmp/source",
      authorizedActions: ["read", "workspace_write", "local_commit"],
      workItems: ["a", "b", "c"].map((id) => ({
        workItemId: id,
        title: id,
        objective: id,
        role: "implementation",
        provider: "pi",
        dependencies: [],
        outputs: ["diff"],
        acceptance: ["test"],
      })),
    }),
    digest: `sha256:${"a".repeat(64)}`,
    status: "approved",
    runs: [],
    events: [],
  };
  const starts: ProviderStart[] = [];
  let allowed = true;
  let stopped = 0;
  const events: string[] = [];
  const host: CollaborationService["host"] = {
    list: async () => [structuredClone(snapshot)],
    authorize: async () => {
      if (!allowed) throw new Error("revoked");
    },
    request: async (operation, value) => {
      if (operation === "event") events.push((value as { kind: string }).kind);
      if (operation === "run") {
        const run = structuredClone(value) as unknown as AgentRun;
        assert.ok(run.status !== "running" || starts.length < 3);
        const old = snapshot.runs.findIndex((saved) => saved.runId === run.runId);
        if (old >= 0) snapshot.runs[old] = run;
        else snapshot.runs.push(run);
      }
      return JSON.parse(JSON.stringify(snapshot));
    },
  };
  const workspace = {
    create: async (_plan: unknown, runId: string) => ({
      path: `/tmp/${runId}`,
      repository: "/tmp/source",
      branch: `codex/${runId}`,
      baselineCommit: "a".repeat(40),
    }),
    deliver: async () => "b".repeat(40),
    integrate: async () => ({ revision: "b".repeat(40), conflict: false }),
    revision: async () => "b".repeat(40),
    diff: async () => "",
    restore: async () => ({
      path: "/tmp/test",
      repository: "/tmp/source",
      branch: "codex/test",
      baselineCommit: "a".repeat(40),
    }),
  };
  const service = new CollaborationService(
    host,
    {
      authorize: async () => {
        throw new Error("denied");
      },
    },
    workspace,
    () =>
      ({
        capabilities: { steer, pause: false, resume: false },
        start(input) {
          starts.push(input);
        },
        steer() {},
        async pause() {},
        async stop() {
          stopped++;
        },
      }) satisfies CodingProviderPort,
    healthTimeoutMs,
  );
  return {
    service,
    snapshot,
    starts,
    events,
    revoke: () => {
      allowed = false;
    },
    get stopped() {
      return stopped;
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only two children start; third waits for persisted completion and gets its own workspace", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await f.service.dispatch("session", "workflow", "a", signal);
  await f.service.dispatch("session", "workflow", "b", signal);
  await f.service.dispatch("session", "workflow", "c", signal);
  await tick();
  assert.equal(f.starts.length, 2);
  assert.equal(f.snapshot.runs.filter((run) => run.status === "running").length, 2);
  assert.notEqual(f.starts[0]!.cwd, f.starts[1]!.cwd);
  f.starts[0]!.emit({ kind: "completed", summary: "first done" });
  await tick();
  await tick();
  assert.equal(f.starts.length, 3);
  assert.equal(f.snapshot.runs[0]?.revision, "b".repeat(40));
  await f.service.dispose();
});

test("revocation stops queued starts; cancel preserves completed attempts and ignores late completion", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await f.service.dispatch("session", "workflow", "a", signal);
  await f.service.dispatch("session", "workflow", "b", signal);
  await f.service.dispatch("session", "workflow", "c", signal);
  await tick();
  f.revoke();
  await f.service.stopWorkflow("workflow");
  f.starts[0]!.emit({ kind: "completed", summary: "late" });
  await tick();
  assert.equal(f.starts.length, 2);
  assert.ok(f.snapshot.runs.every((run) => run.status === "cancelled"));
  assert.ok(!f.snapshot.runs.some((run) => run.summary === "late"));
});

test("reconciling a live blocked run saves exactly one terminal update", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const run = await f.service.dispatch("session", "workflow", "a", signal);
  await tick();
  f.snapshot.runs[0]!.status = "blocked";
  const result = await f.service.reconcile("session", "workflow", run.runId, signal);
  assert.equal((result as WorkflowSnapshot).runs[0]?.status, "cancelled");
  await f.service.dispose();
});
test("persists real capabilities and rejects unsupported live steering", async () => {
  const f = fixture(false);
  const run = await f.service.dispatch("session", "workflow", "a", new AbortController().signal);
  await tick();
  assert.equal(f.snapshot.runs[0]?.capabilities?.steer, false);
  await assert.rejects(f.service.steer(run.runId, "新指令"), /不支持/);
  await f.service.dispose();
});
test("idle health checks notify once without restarting or marking failure", async () => {
  const f = fixture(true, 10);
  await f.service.dispatch("session", "workflow", "a", new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.events.filter((kind) => kind === "run.health").length, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.snapshot.runs[0]?.status, "running");
  await f.service.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.events.filter((kind) => kind === "run.health").length, 1);
});
test("read-only completion cannot attest a changed workspace", async () => {
  const f = fixture();
  f.snapshot.plan.workItems[0]!.role = "review";
  await f.service.dispatch("session", "workflow", "a", new AbortController().signal);
  await tick();
  f.starts[0]!.emit({ kind: "completed", summary: "review done" });
  await tick();
  await tick();
  assert.equal(f.snapshot.runs[0]?.status, "unknown");
  assert.equal(f.snapshot.runs[0]?.revision, undefined);
  await f.service.dispose();
});
