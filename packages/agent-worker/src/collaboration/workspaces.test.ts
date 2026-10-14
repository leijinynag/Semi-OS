import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceService, NeedsUserError } from "./workspaces.ts";
import type { WorkflowPlan, AgentRun } from "@semi-os/protocol";

test("dirty source needs explicit baseline; isolated deliveries integrate without changing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-worktrees-"));
  const repository = join(directory, "source");
  await mkdir(repository);
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  try {
    await git("init");
    await git("config", "user.email", "fixture@example.test");
    await git("config", "user.name", "Fixture");
    await writeFile(join(repository, "initial"), "baseline");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    const plan = { repository } as WorkflowPlan;
    const service = new WorkspaceService(join(directory, "worktrees"));
    await writeFile(join(repository, "user-draft"), "preserve");
    await assert.rejects(service.inspect(plan), NeedsUserError);
    plan.baselineCommit = baseline;
    const a = await service.create(plan, "run_a");
    const b = await service.create(plan, "run_b");
    await writeFile(join(a.path, "a"), "a");
    await writeFile(join(b.path, "b"), "b");
    assert.match(await service.diff(a.path), /未跟踪文件[\s\S]*"a"/);
    const commits = [await service.deliver(a.path, "a"), await service.deliver(b.path, "b")];
    const recovered = new WorkspaceService(join(directory, "worktrees"));
    const saved: AgentRun = {
      runId: "run_a",
      workflowId: "fixture",
      workItemId: "a",
      planVersion: 1,
      intentVersion: 1,
      attempt: 1,
      provider: "pi",
      status: "completed",
      startedAtMs: 1,
      workspace: a.path,
      branch: a.branch,
      baselineCommit: a.baselineCommit,
    };
    await recovered.restore(plan, saved);
    assert.equal(await recovered.revision(a.path), commits[0]);
    await assert.rejects(recovered.restore(plan, { ...saved, runId: "run_b" }), /ownership/);
    const integration = await service.create(plan, "run_integration");
    assert.equal((await service.integrate(integration.path, commits)).conflict, false);
    // 仅改写合成 worktree 的提交祖先，保留同一文件树，排除脏工作区干扰。
    const tree = (
      await exec("git", ["-C", integration.path, "rev-parse", "HEAD^{tree}"])
    ).stdout.trim();
    const orphan = (
      await exec("git", ["-C", integration.path, "commit-tree", tree, "-m", "synthetic rewrite"])
    ).stdout.trim();
    await exec("git", ["-C", integration.path, "update-ref", "HEAD", orphan]);
    await assert.rejects(service.integrate(integration.path, commits), /回退或改写/);
    assert.equal(await git("rev-parse", "HEAD"), baseline);
    assert.equal(await service.clean(a.path), false);
    await assert.rejects(service.deliver(repository, "no"), /owned/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conflicting cherry-picks preserve source and continue remaining deliveries after resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-conflict-"));
  const repository = join(directory, "source");
  await mkdir(repository);
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  try {
    await git("init");
    await git("config", "user.email", "fixture@example.test");
    await git("config", "user.name", "Fixture");
    await writeFile(join(repository, "counter"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    const plan = { repository, baselineCommit: baseline } as WorkflowPlan;
    const service = new WorkspaceService(join(directory, "worktrees"));
    const a = await service.create(plan, "run_a");
    const b = await service.create(plan, "run_b");
    const c = await service.create(plan, "run_c");
    await writeFile(join(a.path, "counter"), "a\n");
    await writeFile(join(b.path, "counter"), "b\n");
    await writeFile(join(c.path, "third"), "c\n");
    const commits = await Promise.all([
      service.deliver(a.path, "a"),
      service.deliver(b.path, "b"),
      service.deliver(c.path, "c"),
    ]);
    const integration = await service.create(plan, "run_integration");
    assert.equal((await service.integrate(integration.path, commits)).conflict, true);
    await assert.rejects(service.deliver(integration.path, "unresolved"), NeedsUserError);
    await writeFile(join(integration.path, "counter"), "resolved\n");
    await service.deliver(integration.path, "resolve");
    assert.equal((await service.integrate(integration.path, commits)).conflict, false);
    assert.equal(await readFile(join(integration.path, "third"), "utf8"), "c\n");
    assert.equal(await readFile(join(integration.path, "counter"), "utf8"), "resolved\n");
    assert.equal(await git("rev-parse", "HEAD"), baseline);
    assert.equal(await readFile(join(repository, "counter"), "utf8"), "base\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source application requires clean exact branch and HEAD, then only fast-forwards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semi-apply-"));
  const repository = join(directory, "source");
  await mkdir(repository);
  const exec = promisify(execFile);
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", repository, ...args])).stdout.trim();
  try {
    await git("init");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await writeFile(join(repository, "initial"), "baseline");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    const service = new WorkspaceService(join(directory, "worktrees"));
    const workspace = await service.create(
      { repository, baselineCommit: baseline } as WorkflowPlan,
      "run_integrate",
    );
    await writeFile(join(workspace.path, "result"), "approved result");
    const revision = await service.deliver(workspace.path, "deliver");
    const target = await service.applicationTarget(workspace.path, revision);
    const request = {
      applicationId: "apply_fixture",
      workflowId: "workflow",
      version: 1,
      digest: `sha256:${"a".repeat(64)}`,
      repository,
      workspace: workspace.path,
      revision,
      ...target,
    };
    await assert.rejects(service.apply({ ...request, expectedHead: "b".repeat(40) }), /已变化/);
    await writeFile(join(repository, "user-draft"), "preserve");
    await assert.rejects(service.apply(request), /未提交/);
    assert.equal(await git("rev-parse", "HEAD"), baseline);
    await rm(join(repository, "user-draft"));
    await git("branch", "other");
    await git("switch", "other");
    await assert.rejects(service.apply(request), /已变化/);
    await git("switch", target.expectedRef.replace("refs/heads/", ""));
    await service.apply(request);
    assert.equal(await git("rev-parse", "HEAD"), revision);
    assert.equal(await readFile(join(repository, "result"), "utf8"), "approved result");
    // 源分支新增提交后已分叉，不能自动合并或退回已验证版本。
    await writeFile(join(repository, "user-next"), "next");
    await git("add", ".");
    await git("commit", "-m", "user next");
    await assert.rejects(service.applicationTarget(workspace.path, revision), /分叉/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
