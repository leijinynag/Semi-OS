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

// 人工触发的真实 Host + CLI 验收；只操作合成仓库，批准由测试桥模拟用户独立作出。
// 不证明主 Pi 自主规划或原生 UI 已验收，也不进入离线单测。
const directory = await mkdtemp(join(tmpdir(), "semi-workflow-live-"));
const repository = join(directory, "source");
await mkdir(repository);
const bridge = spawn(
  resolve("../../target/debug/examples/workflow_bridge"),
  [join(directory, "state.sqlite")],
  {
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void }>();
let sequence = 0;
const lines = createInterface({ input: bridge.stdout });
lines.on("line", (line) => {
  const response = JSON.parse(line) as {
    id: number;
    ok: boolean;
    value: JsonValue;
    error?: string;
  };
  const entry = pending.get(response.id);
  pending.delete(response.id);
  if (response.ok) entry?.resolve(response.value);
  else entry?.reject(new Error(response.error ?? "Host rejected fixture"));
});
bridge.on("exit", () => {
  for (const entry of pending.values()) entry.reject(new Error("Host bridge exited"));
  pending.clear();
});
// 不输出 Provider 环境变量、原始权限参数或 stderr，避免把本地认证带入验收记录。
bridge.stderr.resume();
const request = (operation: string, value: JsonValue) =>
  new Promise<JsonValue>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Host bridge timeout"));
    }, 10_000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    bridge.stdin.write(`${JSON.stringify({ id, operation, value })}\n`);
  });
const signal = new AbortController().signal;
const sessionId = "session_live";
const workflowId = "workflow_live";
const host: CollaborationService["host"] = {
  request: (operation, value) => request(operation, value),
  list: async () => {
    const items = await request("list", { sessionId });
    if (!Array.isArray(items)) throw new Error("invalid Host list");
    return items.map(parseWorkflowSnapshot);
  },
  authorize: async (workflowId, version, digest, workItemId) => {
    await request("authorize", { workflowId, version, digest, workItemId });
  },
};
let permissions = 0;
const service = new CollaborationService(
  host,
  {
    authorize: async (input) => {
      const value = JSON.parse(input.inputJson) as {
        tool?: string;
        command?: string;
        input?: Record<string, unknown>;
      };
      if (value.command === "node check.mjs") return;
      const tool = value.tool ?? "";
      const path = value.input?.path ?? value.input?.file_path;
      const allowedFile =
        typeof path === "string" && /(?:^|\/)(?:README|count\.mjs|check\.mjs)$/.test(path);
      // 测试允许精确合成文件读写；通用 shell、网络及其他文件仍拒绝。
      if (
        (["read", "Read", "write", "Write", "edit", "Edit"].includes(tool) && allowedFile) ||
        ["grep", "Grep", "Glob", "find", "ls"].includes(tool)
      ) {
        permissions++;
        return;
      }
      throw new Error("Synthetic permission rejected");
    },
  },
  new WorkspaceService(join(directory, "worktrees")),
);
const exec = promisify(execFile);
const git = async (...args: string[]) =>
  (await exec("git", ["-C", repository, ...args])).stdout.trim();
const snapshot = async () => (await host.list(sessionId, signal))[0]!;
async function complete(id: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const saved = await snapshot();
    const run = saved.runs.filter((run) => run.workItemId === id).at(-1);
    if (run?.status === "completed") {
      console.log(JSON.stringify({ stage: id, status: "completed" }));
      return run;
    }
    if (run && ["failed", "blocked", "unknown", "cancelled"].includes(run.status)) {
      throw new Error(`${id}: ${run.status} ${run.error ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${id}: timed out`);
}
try {
  await git("init");
  await git("config", "user.name", "Synthetic");
  await git("config", "user.email", "synthetic@example.test");
  await writeFile(join(repository, "README"), "Synthetic count function and test.\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  const baseline = await git("rev-parse", "HEAD");
  await request("session", { sessionId });
  const plan = parseWorkflowPlan({
    workflowId,
    sessionId,
    version: 1,
    intentVersion: 1,
    title: "合成多 Agent 验收",
    goal: "计数函数与测试",
    scope: ["README", "count.mjs", "check.mjs"],
    acceptance: ["node check.mjs 通过", "独立审查绑定整合提交"],
    repository,
    authorizedActions: ["read", "workspace_write", "local_commit", "integrate"],
    workItems: [
      {
        workItemId: "plan",
        role: "planning",
        provider: "pi",
        dependencies: [],
        objective: "用 read 工具读取 README。简述计数函数 n + 1 和独立测试的分工，不修改文件。",
      },
      {
        workItemId: "code",
        role: "implementation",
        provider: "pi",
        dependencies: ["plan"],
        objective:
          "用 write 工具创建 count.mjs，唯一内容为 export const count = (n) => n + 1; 不执行命令，只修改这个文件。",
      },
      {
        workItemId: "tests",
        role: "implementation",
        provider: "claude",
        dependencies: ["plan"],
        objective:
          "用 Write 工具创建 check.mjs，内容为 import { count } from './count.mjs'; if (count(1) !== 2 || count(-1) !== 0) process.exit(1); 不运行命令，只修改这个文件。",
      },
      {
        workItemId: "integrate",
        role: "integration",
        provider: "pi",
        dependencies: ["code", "tests"],
        objective:
          "整合服务已合并两个文件，用 read 工具读取 count.mjs 和 check.mjs，核对接口，已有实现正确则不修改。不执行命令。",
      },
      {
        workItemId: "review",
        role: "review",
        provider: "claude",
        dependencies: ["integrate"],
        objective:
          "仅用 Read 工具独立审查 count.mjs、check.mjs，检查 n+1 及两项断言；报告问题或无问题，不修改文件、不运行命令。",
      },
    ].map((item) => ({
      ...item,
      title: item.workItemId,
      outputs: ["成果与证据"],
      acceptance: ["目标文件符合要求"],
    })),
  });
  const submitted = parseWorkflowSnapshot(
    await request("submit", JSON.parse(JSON.stringify(plan))),
  );
  await assert.rejects(service.dispatch(sessionId, workflowId, "code", signal));
  await service.dispatch(sessionId, workflowId, "plan", signal);
  await complete("plan");
  await request("approve", {
    workflowId,
    version: submitted.plan.version,
    digest: submitted.digest,
  });
  await service.dispatch(sessionId, workflowId, "code", signal);
  await service.dispatch(sessionId, workflowId, "tests", signal);
  const code = await complete("code");
  const tests = await complete("tests");
  assert.notEqual(code.workspace, tests.workspace);
  await service.dispatch(sessionId, workflowId, "integrate", signal);
  const integrated = await complete("integrate");
  const evidence = await service.test(
    sessionId,
    workflowId,
    integrated.runId,
    "node check.mjs",
    signal,
  );
  assert.equal(evidence.exitCode, 0);
  await service.dispatch(sessionId, workflowId, "review", signal);
  const review = await complete("review");
  assert.equal(review.revision, integrated.revision);
  // 审查完成只是版本证据；合成任务的无问题结论由此验收脚本核对，不冒充模型结构化结论。
  assert.match(review.summary ?? "", /无问题|没有发现|未发现|no issues|正确|通过/i);
  await service.recordIntegration(
    sessionId,
    workflowId,
    {
      workspace: integrated.workspace,
      branch: integrated.branch,
      revision: integrated.revision,
      status: "verified",
      commits: [code.revision, tests.revision],
      tests: [evidence],
      reviews: [{ runId: review.runId, revision: review.revision, findingIds: [] }],
    },
    signal,
  );
  assert.equal((await snapshot()).integration?.status, "verified");
  assert.equal(await git("rev-parse", "HEAD"), baseline);
  assert.equal(await git("status", "--porcelain"), "");
  console.log(
    JSON.stringify({
      result: "passed",
      host: "Rust/SQLite",
      providers: ["pi", "claude"],
      attempts: (await snapshot()).runs.length,
      permissions,
      testExitCode: evidence.exitCode,
      independentReview: true,
      sourceUnchanged: true,
    }),
  );
} finally {
  await service.dispose();
  lines.close();
  bridge.stdin.end();
  if (bridge.exitCode === null)
    await new Promise<void>((resolve) => bridge.once("exit", () => resolve()));
  await rm(directory, { recursive: true, force: true });
}
