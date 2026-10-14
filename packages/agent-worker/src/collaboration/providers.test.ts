import test from "node:test";
import assert from "node:assert/strict";
import { PiCodingProvider } from "./pi-provider.ts";
import { ClaudeCodingProvider } from "./claude-provider.ts";
import { CodexCodingProvider } from "./codex-provider.ts";
import type { ProcessOptions } from "./process.ts";
import type { ProcessFactory, ProviderEvent, ProviderStart } from "./provider.ts";

function fixture() {
  const messages: Record<string, unknown>[] = [];
  const events: ProviderEvent[] = [];
  let options: ProcessOptions;
  let stopped = false;
  const factory: ProcessFactory = (value) => {
    options = value;
    return {
      write(value) {
        messages.push(value as Record<string, unknown>);
      },
      async stop() {
        stopped = true;
      },
    };
  };
  const input: ProviderStart = {
    cwd: "/tmp/synthetic",
    prompt: "Read the counter",
    writing: false,
    emit: (event) => events.push(event),
    permission: async () => false,
  };
  return {
    factory,
    input,
    messages,
    events,
    line: (value: unknown) => options.onLine(JSON.stringify(value)),
    error: (message: string) => options.onError(new Error(message)),
    get args() {
      return options.args;
    },
    get stopped() {
      return stopped;
    },
  };
}

test("process failures expose only fixed categories and never arbitrary error text", () => {
  for (const [message, expected] of [
    ["provider input closed", "输入管道"],
    ["process frame limit exceeded", "大小限制"],
    ["secret-error-from-provider", "进程不可用"],
  ]) {
    const f = fixture();
    new ClaudeCodingProvider(f.factory).start(f.input);
    f.error(message!);
    const failure = f.events.at(-1);
    assert.equal(failure?.kind, "failed");
    if (failure?.kind === "failed") {
      assert.ok(failure.message.includes(expected!));
      assert.ok(!failure.message.includes("secret-error"));
    }
  }
});

test("Pi uses RPC state, routes every tool permission, and clears queued input on cancel", async () => {
  const f = fixture();
  const provider = new PiCodingProvider(f.factory);
  provider.start(f.input);
  assert.equal(f.messages[0]?.type, "get_state");
  assert.ok(f.args.includes("--no-context-files"));
  f.line({
    type: "response",
    id: "session",
    success: true,
    data: { sessionFile: "/tmp/pi-session" },
  });
  f.line({
    type: "extension_ui_request",
    id: "permission",
    method: "confirm",
    title: "semi-os-tool-policy",
    message: JSON.stringify({ tool: "write", input: { path: "x" } }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.messages.at(-1)?.confirmed, false);
  f.line({ type: "agent_end", messages: [{ stopReason: "error" }, { stopReason: "stop" }] });
  assert.equal(f.events.at(-1)?.kind, "completed");
  await provider.stop();
  assert.deepEqual(
    f.messages.slice(-2).map((message) => message.type),
    ["clear_queue", "abort"],
  );
  assert.ok(f.stopped);
});

test("Claude waits for permissions initialization and fails closed when Host is unavailable", async () => {
  const f = fixture();
  f.input.permission = async () => {
    throw new Error("host offline");
  };
  new ClaudeCodingProvider(f.factory).start(f.input);
  assert.equal(f.messages.length, 1);
  assert.ok(!f.args.includes("--dangerously-skip-permissions"));
  f.line({ type: "control_response", response: { request_id: "semi_init", subtype: "success" } });
  assert.equal(f.messages.at(-1)?.type, "user");
  f.line({
    type: "control_request",
    request_id: "hook",
    request: {
      subtype: "hook_callback",
      callback_id: "semi_policy",
      input: { tool_name: "Write", tool_input: { file_path: "x" } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = f.messages.at(-1) as {
    response: { response: { hookSpecificOutput: { permissionDecision: string } } };
  };
  assert.equal(reply.response.response.hookSpecificOutput.permissionDecision, "deny");
  f.line({ type: "result", subtype: "success", result: "done" });
  assert.deepEqual(f.events.at(-1), { kind: "completed", summary: "done" });
});

test("Claude classifies known failures without exposing raw provider payloads", () => {
  for (const [subtype, errors, expected] of [
    ["error_max_turns", [], "轮数上限"],
    ["error_during_execution", ["HTTP 429 sk-synthetic-secret"], "限流"],
    ["error_during_execution", ["401 invalid api key sk-synthetic-secret"], "认证"],
    ["error_during_execution", ["ECONNRESET sk-synthetic-secret"], "网络"],
    ["error_during_execution", ["credit balance insufficient sk-synthetic-secret"], "额度"],
    ["error_during_execution", ["unknown sk-synthetic-secret"], "不能据此认定"],
  ] as const) {
    const f = fixture();
    new ClaudeCodingProvider(f.factory).start(f.input);
    f.line({ type: "result", subtype, is_error: true, errors });
    const failure = f.events.at(-1);
    assert.equal(failure?.kind, "failed");
    if (failure?.kind === "failed") {
      assert.ok(failure.message.includes(expected));
      assert.ok(!failure.message.includes("sk-synthetic-secret"));
    }
  }
});

test("Claude forwards structured questions and returns updated answers without terminal input", async () => {
  const f = fixture();
  f.input.decision = async (request) => {
    assert.equal(request.kind, "clarification");
    return { answers: { "Which implementation?": "Use the approved scope" } };
  };
  new ClaudeCodingProvider(f.factory).start(f.input);
  f.line({
    type: "control_request",
    request_id: "question",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Which implementation?" }] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const response = f.messages.at(-1) as {
    response: { response: { behavior: string; updatedInput: { answers: unknown } } };
  };
  assert.equal(response.response.response.behavior, "allow");
  assert.deepEqual(response.response.response.updatedInput.answers, {
    "Which implementation?": "Use the approved scope",
  });
});

test("Codex isolates a thread and denies unknown server requests; late output after stop is ignored", async () => {
  const f = fixture();
  const provider = new CodexCodingProvider(f.factory);
  provider.start(f.input);
  f.line({ id: "semi_1", result: {} });
  f.line({ id: "semi_2", result: { thread: { id: "thread" } } });
  f.line({ id: "semi_3", result: { turn: { id: "turn" } } });
  provider.steer("review the tests");
  assert.equal(f.messages.at(-1)?.method, "turn/steer");
  f.line({ id: 7, method: "item/fileChange/requestApproval", params: { threadId: "thread" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.messages.at(-1)?.result, { decision: "decline" });
  f.line({ id: 8, method: "unknown/permission", params: {} });
  assert.ok(f.messages.at(-1)?.error);
  await provider.stop();
  f.line({ method: "item/agentMessage/delta", params: { threadId: "thread", delta: "late" } });
  f.line({
    method: "turn/completed",
    params: { threadId: "thread", turn: { status: "completed" } },
  });
  assert.ok(!f.events.some((event) => event.kind === "completed" || event.kind === "text"));
});
