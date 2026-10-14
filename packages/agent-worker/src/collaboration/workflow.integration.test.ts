import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWorkflowPlan, type AgentRun, type WorkflowSnapshot } from "@semi-os/protocol";
import { CollaborationService } from "./service.ts";
import { WorkspaceService } from "./workspaces.ts";
import type { ProviderStart } from "./provider.ts";

// 合成 Provider 只替代模型和权限 UI，Git 工作区、提交、整合与测试运行器走真实边界。
test("approved DAG runs planning, two isolated deliveries, integration, real test and independent review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-workflow-e2e-"));
  const repository = join(directory, "source");
  await mkdir(repository);
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  const starts: ProviderStart[] = [];
  let approved = false;
  const snapshot: WorkflowSnapshot = {
    plan: parseWorkflowPlan({
      workflowId: "workflow_e2e",
      sessionId: "session_e2e",
      version: 1,
      intentVersion: 1,
      title: "合成项目",
      goal: "实现计数函数及校验",
      scope: ["count.mjs", "check.mjs"],
      acceptance: ["真实测试通过", "独立审查"],
      repository,
      authorizedActions: ["read", "workspace_write", "local_commit", "integrate"],
      workItems: [
        { workItemId: "plan", role: "planning", provider: "claude", dependencies: [] },
        { workItemId: "code", role: "implementation", provider: "pi", dependencies: ["plan"] },
        { workItemId: "tests", role: "implementation", provider: "codex", dependencies: ["plan"] },
        {
          workItemId: "integrate",
          role: "integration",
          provider: "pi",
          dependencies: ["code", "tests"],
        },
        { workItemId: "review", role: "review", provider: "claude", dependencies: ["integrate"] },
      ].map((item) => ({
        ...item,
        title: item.workItemId,
        objective: item.workItemId,
        outputs: ["证据"],
        acceptance: ["范围内完成"],
      })),
    }),
    digest: `sha256:${"a".repeat(64)}`,
    status: "awaiting_approval",
    runs: [],
    events: [],
  };
  const host: CollaborationService["host"] = {
    list: async () => [structuredClone(snapshot)],
    authorize: async (_id, _version, _digest, item) => {
      if (!approved && item !== "plan") throw new Error("approval required");
    },
    request: async (operation, value) => {
      if (operation === "run") {
        const run = structuredClone(value) as unknown as AgentRun;
        const index = snapshot.runs.findIndex((saved) => saved.runId === run.runId);
        if (index < 0) snapshot.runs.push(run);
        else snapshot.runs[index] = run;
      }
      if (operation === "test")
        assert.equal((value as { evidence: { exitCode: number } }).evidence.exitCode, 0);
      return JSON.parse(JSON.stringify(snapshot));
    },
  };
  const service = new CollaborationService(
    host,
    { authorize: async () => {} },
    new WorkspaceService(join(directory, "worktrees")),
    () => ({
      capabilities: { steer: true, pause: false, resume: true },
      start(input) {
        starts.push(input);
      },
      steer() {},
      async pause() {},
      async stop() {},
    }),
  );
  const signal = new AbortController().signal;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "workflow timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const finish = async (index: number) => {
    const run = snapshot.runs[index]!;
    starts
      .find((start) => start.cwd === run.workspace)!
      .emit({ kind: "completed", summary: "fixture evidence" });
    await waitFor(() => snapshot.runs[index]?.status === "completed");
  };
  try {
    await git("init");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await writeFile(join(repository, "README"), "synthetic\n");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    await assert.rejects(
      service.dispatch("session_e2e", "workflow_e2e", "code", signal),
      /approval/,
    );
    await service.dispatch("session_e2e", "workflow_e2e", "plan", signal);
    await waitFor(() => starts.length === 1);
    await finish(0);
    approved = true;
    snapshot.status = "approved";
    await service.dispatch("session_e2e", "workflow_e2e", "code", signal);
    await service.dispatch("session_e2e", "workflow_e2e", "tests", signal);
    await waitFor(() => starts.length === 3);
    assert.notEqual(starts[1]!.cwd, starts[2]!.cwd);
    await writeFile(join(starts[1]!.cwd, "count.mjs"), "export const count = (n) => n + 1;\n");
    await writeFile(
      join(starts[2]!.cwd, "check.mjs"),
      "import { count } from './count.mjs';\nif (count(1) !== 2) process.exit(1);\n",
    );
    await finish(1);
    await finish(2);
    await service.dispatch("session_e2e", "workflow_e2e", "integrate", signal);
    await waitFor(() => starts.length === 4);
    assert.match(await readFile(join(starts[3]!.cwd, "count.mjs"), "utf8"), /n \+ 1/);
    await finish(3);
    const integrated = snapshot.runs[3]!;
    const evidence = await service.test(
      "session_e2e",
      "workflow_e2e",
      integrated.runId,
      "node check.mjs",
      signal,
    );
    assert.equal(evidence.revision, integrated.revision);
    await service.dispatch("session_e2e", "workflow_e2e", "review", signal);
    await waitFor(() => starts.length === 5);
    assert.equal(snapshot.runs[4]?.baselineCommit, integrated.revision);
    await finish(4);
    assert.equal(snapshot.runs[4]?.revision, integrated.revision);
    assert.equal(await git("rev-parse", "HEAD"), baseline);
    assert.equal(await git("status", "--porcelain"), "");
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
