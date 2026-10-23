import assert from "node:assert/strict";
import test from "node:test";
import {
  executionActions,
  parseExecution,
  safeSourceUrl,
  type ExecutionSnapshot,
} from "./execution.ts";

function fixture(): ExecutionSnapshot {
  return {
    taskId: "task_a",
    lifecycle: "running",
    approvals: [],
    sources: [],
    progress: [
      { sequence: 1, callId: "call_first", toolName: "bash", label: "执行工具" },
      { sequence: 2, callId: "call_second", toolName: "bash", label: "执行工具" },
    ],
    receipts: [
      {
        attemptId: "attempt_random",
        taskId: "task_a",
        toolName: "bash",
        idempotencyKey: "task_a:call_second",
        status: "unknown",
        inputSummary: "测试命令",
      },
    ],
  };
}
test("关联幂等键而非工具名，unknown 不变成成功", () => {
  const actions = executionActions(parseExecution(fixture(), "task_a"));
  assert.equal(actions[0]?.status, "started");
  assert.equal(actions[1]?.receipt?.attemptId, "attempt_random");
  assert.equal(actions[1]?.status, "unknown");
});
test("暂停或结束后未收回执的调用不继续显示执行中", () => {
  const value = fixture();
  value.lifecycle = "paused";
  assert.equal(executionActions(value)[0]?.status, "unknown");
});
test("重复事件与回执去重，保存报告不是悬挂工具", () => {
  const value = fixture();
  value.progress.push(value.progress[0]!, {
    sequence: 3,
    callId: "saved",
    toolName: "research_report",
    label: "报告已保存",
  });
  value.receipts.push(value.receipts[0]!);
  assert.equal(executionActions(value).length, 2);
});
test("拒绝跨任务回执、未知状态与畸形 IPC", () => {
  const value = fixture();
  assert.throws(() => parseExecution(value, "task_b"));
  assert.throws(() =>
    parseExecution(
      { ...value, receipts: [{ ...value.receipts[0], taskId: "task_other" }] },
      "task_a",
    ),
  );
  assert.throws(() => parseExecution({ ...value, lifecycle: "pretend_success" }, "task_a"));
  assert.throws(() => parseExecution({ ...value, progress: null }, "task_a"));
});
test("来源只能打开 http(s)，不允许执行脚本", () => {
  assert.equal(safeSourceUrl("javascript:alert(1)"), undefined);
  assert.equal(safeSourceUrl("file:///etc/passwd"), undefined);
  assert.equal(safeSourceUrl("https://example.com/"), "https://example.com/");
});
