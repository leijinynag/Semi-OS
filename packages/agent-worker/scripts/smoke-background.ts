import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkflowPlan, parseWorkflowSnapshot, type JsonValue } from "@semi-os/protocol";
import { CollaborationService } from "../src/collaboration/service.ts";
import { WorkspaceService } from "../src/collaboration/workspaces.ts";
import { WorkflowCoordinator } from "../src/collaboration/coordinator.ts";
import { WorkflowHost } from "../src/collaboration/workflow-host.ts";
import { createCoordinatorTools } from "../src/collaboration/workflow-tools.ts";
import { PiAgentRuntime } from "../src/pi-runtime.ts";
import { readCloudLlmConfig, resolveCloudLlmModel } from "../src/config/llm.ts";

// 真人验收入口：脚本只建合成仓库、提交总计划并批准一次，之后只观察。
// 不代替 Pi 选择派单/整合/测试/审查，也不批准未知命令；不会修改用户源仓库。
const directory = await mkdtemp(join(tmpdir(), "semi-background-live-"));
const repository = join(directory, "source");
await mkdir(repository);
const bridge = spawn(
  resolve("../../target/debug/examples/workflow_bridge"),
  [join(directory, "state.sqlite")],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void }>();
let sequence = 0;
let coordinator: WorkflowCoordinator | undefined;
const lines = createInterface({ input: bridge.stdout });
lines.on("line", (line) => {
  const value = JSON.parse(line) as { id: number; ok: boolean; value: JsonValue; error?: string };
  const entry = pending.get(value.id);
  pending.delete(value.id);
  if (value.ok) entry?.resolve(value.value);
  else entry?.reject(new Error(value.error ?? "Host rejected"));
});
bridge.stderr.resume();
bridge.on("exit", () => {
  for (const entry of pending.values()) entry.reject(new Error("Host bridge exited"));
  pending.clear();
});
const request = (operation: string, value: JsonValue) =>
  new Promise<JsonValue>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Host workflow acknowledgement timed out"));
    }, 10_000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(cause) {
        clearTimeout(timer);
        reject(cause);
      },
    });
    bridge.stdin.write(`${JSON.stringify({ id, operation, value })}\n`);
  });
const host = new WorkflowHost((event) => {
  if (
    event.direction !== "event" ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  )
    throw new Error("Invalid request");
  const payload = event.payload;
  const operation = String(payload.operation);
  void request(operation, payload.value ?? null).then(
    (value) => {
      host.acknowledge({ operationId: payload.operationId!, ok: true, value });
      if (
        (operation === "run" &&
          payload.value &&
          typeof payload.value === "object" &&
          !Array.isArray(payload.value) &&
          ["completed", "failed", "blocked", "unknown"].includes(String(payload.value.status))) ||
        operation === "delegate.request"
      )
        coordinator?.wake("workflow_live_background");
    },
    (cause) =>
      host.acknowledge({ operationId: payload.operationId!, ok: false, error: cause.message }),
  );
});
const service = new CollaborationService(
  host,
  {
    authorize: async () => {
      throw new Error("Unexpected human permission request");
    },
  },
  new WorkspaceService(join(directory, "worktrees")),
);
let turns = 0;
const calls: Record<string, number> = {};
coordinator = new WorkflowCoordinator({
  host,
  directory: join(directory, "coordinators"),
  restoreQueued: (snapshot, signal) => service.restoreQueued(snapshot, signal),
  tools: (snapshot) => createCoordinatorTools(host, snapshot, service),
  runtime: () => {
    const runtime = new PiAgentRuntime({
      isolatedResources: true,
      baseToolNames: [],
      resolvePolicyDecision: async () => "auto",
      model: resolveCloudLlmModel(readCloudLlmConfig()),
      systemPrompt: [
        "你是 Semi-OS 后台协调者，使用协作工具自主推进已批准的总计划，不要求用户重复批准范围内实施。",
        "有执行中尝试时结束轮次等待事件；不要重复派单。先观察实际成果，再整合、运行测试、派独立审查。",
        "完成必须 workflow_record_integration verified，包含真实测试 Artifact、独立审查和交付提交。",
        "发现失败可在已批准范围内调整计划返工；不 push、不应用到源分支。",
      ].join("\n"),
    });
    turns++;
    runtime.subscribe((event) => {
      if (event.kind === "tool.requested") {
        calls[event.toolName] = (calls[event.toolName] ?? 0) + 1;
        console.log(JSON.stringify({ turn: turns, tool: event.toolName }));
      }
      if (event.kind === "runtime.error")
        console.log(JSON.stringify({ turn: turns, error: "coordinator_runtime_failed" }));
    });
    return runtime;
  },
});
const exec = promisify(execFile);
const git = async (...args: string[]) =>
  (await exec("git", ["-C", repository, ...args])).stdout.trim();
const signal = new AbortController().signal;
try {
  await git("init");
  await git("config", "user.name", "Synthetic");
  await git("config", "user.email", "synthetic@example.test");
  await writeFile(
    join(repository, "README"),
    "Implement count(n)=n+1 and test count(1)=2 and count(-1)=0.\n",
  );
  await git("add", ".");
  await git("commit", "-m", "baseline");
  const baseline = await git("rev-parse", "HEAD");
  await request("session", { sessionId: "session_background" });
  const plan = parseWorkflowPlan({
    workflowId: "workflow_live_background",
    sessionId: "session_background",
    version: 1,
    intentVersion: 1,
    title: "后台计数模块验收",
    goal: "计数函数与独立测试",
    scope: ["README", "count.mjs", "check.mjs"],
    acceptance: ["node check.mjs 通过", "独立审查绑定整合提交"],
    repository,
    authorizedActions: ["read", "workspace_write", "local_commit", "integrate"],
    workItems: [
      {
        workItemId: "code",
        role: "implementation",
        provider: "pi",
        dependencies: [],
        objective:
          "只用 write 创建 count.mjs，内容 export const count = (n) => n + 1; 不运行命令。",
      },
      {
        workItemId: "tests",
        role: "implementation",
        provider: "claude",
        dependencies: [],
        objective:
          "只用 Write 创建 check.mjs，内容 import { count } from './count.mjs'; if (count(1) !== 2 || count(-1) !== 0) process.exit(1); 不运行命令。",
      },
      {
        workItemId: "integrate",
        role: "integration",
        provider: "pi",
        dependencies: ["code", "tests"],
        objective:
          "受控服务已合并依赖文件。仅用 read 核对 count.mjs 与 check.mjs 的接口；正确则不要修改，不运行命令。",
      },
      {
        workItemId: "review",
        role: "review",
        provider: "claude",
        dependencies: ["integrate"],
        objective:
          "仅用 Read 独立审查 count.mjs 与 check.mjs，报告问题或无问题，不修改、不运行命令。",
      },
    ].map((item) => ({
      ...item,
      title: item.workItemId,
      outputs: ["版本绑定的交付"],
      acceptance: ["满足目标"],
    })),
  });
  const submitted = await host.submit(plan, signal);
  await request("approve", { workflowId: plan.workflowId, version: 1, digest: submitted.digest });
  coordinator.wake(plan.workflowId);
  const deadline = Date.now() + 600_000;
  let finished = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = (await host.list(plan.sessionId, signal))[0]!;
    if (snapshot.background?.coordinator.executionStatus === "needs_user")
      throw new Error(`后台需要用户：${snapshot.background.coordinator.reason}`);
    if (snapshot.background?.coordinator.executionStatus === "completed") {
      assert.equal(snapshot.integration?.status, "verified");
      assert(snapshot.integration.tests.every((item) => item.exitCode === 0));
      assert.equal(await git("rev-parse", "HEAD"), baseline);
      assert.equal(await git("status", "--porcelain"), "");
      assert(
        snapshot.runs.filter((run) => run.workItemId === "code").at(-1)?.workspace !==
          snapshot.runs.filter((run) => run.workItemId === "tests").at(-1)?.workspace,
      );
      console.log(
        JSON.stringify({
          result: "passed",
          turns,
          calls,
          attempts: snapshot.runs.length,
          humanPlanApprovals: 1,
          autonomousCoordinator: true,
          sourceUnchanged: true,
          independentReview: true,
        }),
      );
      finished = true;
      break;
    }
  }
  if (!finished) throw new Error("后台验收超时，未证明自主闭环");
} finally {
  await coordinator.dispose();
  await service.dispose();
  host.dispose();
  lines.close();
  bridge.stdin.end();
  if (bridge.exitCode === null)
    await new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
