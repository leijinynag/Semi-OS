import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope, JsonValue, RequestEnvelope, RequestId } from "@semi-os/protocol";
import type { ToolExecutionReceipt } from "@semi-os/tool-sdk";
import { EventedAgentRuntime, type AgentRuntimeEvent } from "./runtime.ts";
import { FakeSttProvider, FakeTtsProvider } from "./voice/fake-providers.ts";
import { VoiceLoop } from "./voice/voice-loop.ts";
import { WorkerService } from "./worker-service.ts";
import {
  experienceCompletionStatus,
  persistVerifiedExperience,
  planVerifiedExperience,
  type ExperienceCompletionStatus,
  type ExperienceObservation,
  type ExperienceToolObservation,
} from "./experience-persistence.ts";

const verifiedTool: ExperienceToolObservation = {
  attemptId: "attempt_open",
  taskId: "task_release",
  toolName: "browser_open",
  status: "succeeded",
  resultType: "success",
  verificationStatus: "passed",
  verificationMethod: "fixture",
  evidenceCount: 1,
  outputSummary: "打开资料页",
};

function observation(
  tools: ExperienceToolObservation[],
  status: ExperienceCompletionStatus = experienceCompletionStatus(tools),
  summary = "打开资料页并核对标题",
): ExperienceObservation {
  return {
    scope: { userId: "local", workspaceId: "repo_semi" },
    tools,
    completion: { taskId: "task_release", status },
    summary: { taskId: "task_release", summary },
  };
}

test("a verified workflow becomes reusable L3 and L5 candidates", () => {
  const candidates = planVerifiedExperience(observation([verifiedTool]));
  const kinds = candidates.map((candidate) => candidate.recordKind).sort();
  assert.deepEqual(kinds, ["task_summary", "verified_outcome", "workflow_candidate"]);
  assert.ok(candidates.every((candidate) => candidate.origin === "verified_experience"));
  assert.ok(candidates.every((candidate) => candidate.conflictTarget === null));
  assert.ok(
    candidates.every(
      (candidate) =>
        candidate.scope.workspaceId === "repo_semi" && candidate.scope.taskId === undefined,
    ),
  );
  const workflow = candidates.find((candidate) => candidate.recordKind === "workflow_candidate");
  assert.equal(workflow?.layer, "L5");
  assert.match(String(workflow?.content.summary), /已验证步骤：browser_open：打开资料页/);
  assert.ok(
    workflow?.sourceRefs.some((source) => String(source.note).includes("completion=completed")),
  );
  assert.ok(
    workflow?.sourceRefs.some(
      (source) =>
        String(source.note).includes("status=succeeded") &&
        String(source.note).includes("verification=passed") &&
        String(source.note).includes("method=fixture"),
    ),
  );
  assert.ok(!candidates.some((candidate) => candidate.recordKind === "skill_candidate"));
});

test("failed or unknown operations do not become executable experience", () => {
  const failed: ExperienceToolObservation = {
    ...verifiedTool,
    attemptId: "attempt_failed",
    toolName: "browser_click",
    status: "failed",
    resultType: "failure",
    verificationStatus: "failed",
    outputSummary: "不应执行的失败步骤",
  };
  const unknown: ExperienceToolObservation = {
    ...verifiedTool,
    attemptId: "attempt_unknown",
    toolName: "browser_type",
    status: "unknown",
    resultType: "unknown",
    verificationStatus: "inconclusive",
    outputSummary: "未知是否已经输入",
  };
  const prose: ExperienceToolObservation = {
    ...verifiedTool,
    verificationMethod: "model_prose",
    outputSummary: "模型自称已经完成",
  };
  for (const tools of [
    [failed],
    [unknown],
    [prose],
    [verifiedTool, unknown],
    [verifiedTool, failed],
  ]) {
    const candidates = planVerifiedExperience(observation(tools));
    assert.equal(
      candidates.some((candidate) => candidate.recordKind === "workflow_candidate"),
      false,
      JSON.stringify(tools.map((tool) => tool.toolName)),
    );
    assert.equal(
      candidates.some((candidate) => candidate.recordKind === "task_summary"),
      false,
    );
    const rendered = JSON.stringify(candidates);
    assert.equal(rendered.includes("不应执行的失败步骤"), false);
    assert.equal(rendered.includes("未知是否已经输入"), false);
    assert.equal(rendered.includes("模型自称已经完成"), false);
    assert.equal(rendered.includes("browser_click"), false);
    assert.equal(rendered.includes("browser_type"), false);
  }
  const mixed = planVerifiedExperience(observation([verifiedTool, failed]));
  assert.deepEqual(
    mixed.map((candidate) => candidate.recordKind),
    ["verified_outcome"],
  );
  assert.match(String(mixed[0]?.content.summary), /browser_open/);
});

test("secret text is removed before a candidate is submitted", () => {
  const secretTool: ExperienceToolObservation = {
    ...verifiedTool,
    outputSummary: "api_key=abcd1234efgh",
  };
  const candidates = planVerifiedExperience(
    observation([secretTool], "completed", "结论里有 api_key=abcd1234efgh"),
  );
  const rendered = JSON.stringify(candidates);
  assert.equal(rendered.includes("api_key"), false);
  assert.equal(rendered.includes("abcd1234efgh"), false);
  assert.equal(
    candidates.some((candidate) => candidate.recordKind === "workflow_candidate"),
    false,
  );
  assert.equal(
    candidates.some((candidate) => candidate.recordKind === "task_summary"),
    false,
  );
});

test("memory writes do not run before the first utterance is released", async () => {
  const order: string[] = [];
  order.push("voice.sentence");
  const pending = persistVerifiedExperience(
    observation([verifiedTool]),
    async () => {
      order.push("memory.candidate.submit");
    },
    new AbortController().signal,
  );
  order.push("voice.answer");
  assert.deepEqual(order, ["voice.sentence", "voice.answer"]);
  await pending;
  assert.equal(order.at(-1), "memory.candidate.submit");
  assert.ok(order.indexOf("voice.sentence") < order.indexOf("memory.candidate.submit"));
});

test("cancelled, concurrent and failed tasks do not plan incorrect long-term memories", () => {
  const good = planVerifiedExperience(observation([verifiedTool]));
  const cancelled = planVerifiedExperience({
    scope: { userId: "local", workspaceId: "repo_semi" },
    tools: [],
    completion: { taskId: "task_cancel", status: "cancelled" },
    summary: { taskId: "task_cancel", summary: "取消后不该留下的步骤" },
  });
  const failedTool: ExperienceToolObservation = {
    ...verifiedTool,
    attemptId: "attempt_failed",
    taskId: "task_failed",
    toolName: "browser_click",
    status: "failed",
    resultType: "failure",
    verificationStatus: "failed",
    outputSummary: "失败后不该留下的步骤",
  };
  const failed = planVerifiedExperience({
    scope: { userId: "local", workspaceId: "repo_semi" },
    tools: [failedTool],
    completion: { taskId: "task_failed", status: "failed" },
    summary: { taskId: "task_failed", summary: "失败后不该留下的步骤" },
  });
  const concurrent = [...good, ...cancelled, ...failed];
  const rendered = JSON.stringify(concurrent);
  assert.equal(cancelled.length, 0);
  assert.equal(failed.length, 0);
  assert.ok(good.some((candidate) => candidate.recordKind === "workflow_candidate"));
  assert.equal(rendered.includes("取消后不该留下的步骤"), false);
  assert.equal(rendered.includes("失败后不该留下的步骤"), false);
  assert.equal(rendered.includes("browser_click"), false);
  assert.equal(rendered.includes("打开资料页"), true);
  assert.ok(good.every((candidate) => !candidate.memoryId.includes("task_failed")));
  assert.ok(good.every((candidate) => !candidate.memoryId.includes("task_cancel")));
});

test("one write failure does not drop the rest of the batch", async () => {
  const seen: string[] = [];
  const failures = await persistVerifiedExperience(
    observation([verifiedTool]),
    async (candidate) => {
      seen.push(candidate.memoryId);
      if (seen.length === 1) throw new Error("storage rejected");
    },
    new AbortController().signal,
  );
  assert.equal(seen.length, 3);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "storage rejected");
  assert.equal(failures[0]?.reason.includes("voice"), false);
});

test("background persistence returns before the host write finishes", async () => {
  let entered = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = persistVerifiedExperience(
    observation([verifiedTool]),
    async () => {
      entered = true;
      await gate;
    },
    new AbortController().signal,
  );
  assert.equal(entered, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, true);
  release();
  await pending;
});

function request(kind: string, payload: JsonValue): RequestEnvelope {
  return {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_experience" as RequestId,
    kind,
    payload,
  };
}

function receipt(
  status: ToolExecutionReceipt["status"],
  resultType: ToolExecutionReceipt["resultType"],
): ToolExecutionReceipt {
  const passed = status === "succeeded" && resultType === "success";
  return {
    attemptId: passed ? "attempt_open" : "attempt_bad",
    taskId: "task_release",
    toolName: passed ? "browser_open" : "browser_click",
    idempotencyKey: "open:docs",
    attemptNumber: 1,
    status,
    riskLevel: "read",
    inputSummary: "打开资料页",
    inputDigest: "sha256:input",
    policyDecision: "auto",
    startedAtMs: 1,
    finishedAtMs: 2,
    resultType,
    outputSummary: passed ? "打开资料页" : "不应执行的失败步骤",
    verification: {
      status: passed ? "passed" : status === "unknown" ? "inconclusive" : "failed",
      method: "fixture",
      summary: passed ? "标题匹配" : "没有读回",
      evidence: [{ kind: "fixture", reference: "page:title" }],
    },
    artifacts: [],
  };
}

class ScriptedRuntime extends EventedAgentRuntime {
  readonly #script: AgentRuntimeEvent[];

  constructor(script: AgentRuntimeEvent[]) {
    super();
    this.#script = script;
  }

  async startSession(input: { sessionId: string }) {
    return { sessionId: input.sessionId };
  }

  async prompt(input: { taskId: string }) {
    for (const event of this.#script) {
      this.publish(event.kind === "turn.completed" ? { ...event, taskId: input.taskId } : event);
    }
  }

  async steer() {}
  async followUp() {}
  async pause() {
    return {
      checkpoint: { sessionId: "session_release", sequence: 0, data: {} },
      interrupted: false,
    };
  }
  async abort() {}
  async replaceTools() {}
  async checkpoint() {
    return { sessionId: "session_release", sequence: 0, data: {} };
  }
  async dispose() {}
}

test("first utterance and the task result are emitted before the background write", async () => {
  const emitted: Envelope[] = [];
  const runtime = new ScriptedRuntime([
    { kind: "tool.completed", receipt: receipt("succeeded", "success") },
    { kind: "assistant.text_delta", text: "打开资料页并核对标题。" },
    { kind: "turn.completed", taskId: "task_release" },
  ]);
  let service: WorkerService;
  service = new WorkerService({
    emit: (envelope) => {
      emitted.push(envelope);
      if (envelope.kind !== "memory.candidate.submit") return;
      const payload = envelope.payload as { operationId?: string; memoryId?: string };
      const operationId = payload.operationId;
      const memoryId = payload.memoryId;
      if (!operationId || !memoryId) return;
      queueMicrotask(() => {
        void service.handle({
          direction: "request",
          protocolVersion: 1,
          requestId: operationId as RequestId,
          kind: "memory.candidate.result",
          payload: {
            operationId,
            status: "stored",
            memoryId,
          },
        });
      });
    },
    createVoiceLoop: (emit) =>
      new VoiceLoop({
        runtime,
        emit,
        stt: new FakeSttProvider("继续"),
        tts: new FakeTtsProvider(),
      }),
  });
  try {
    const accepted = await service.handle(
      request("voice.text.submit", {
        sessionId: "session_release",
        taskId: "task_release",
        cwd: "repo_semi",
        text: "打开资料页并核对标题",
      }),
    );
    assert.equal(accepted.kind, "voice.text.accepted");
    assert.equal(
      emitted.some((event) => event.kind === "memory.candidate.submit"),
      false,
    );
    await waitFor(
      () => emitted.filter((event) => event.kind === "memory.candidate.submit").length >= 3,
    );
    const index = (kind: string) => emitted.findIndex((event) => event.kind === kind);
    assert.ok(index("voice.sentence") >= 0);
    assert.ok(index("voice.answer") >= 0);
    assert.ok(index("voice.sentence") < index("memory.candidate.submit"));
    assert.ok(index("voice.answer") < index("memory.candidate.submit"));
    assert.ok(index("voice.turn.completed") < index("memory.candidate.submit"));
    const submits = emitted.filter((event) => event.kind === "memory.candidate.submit");
    const kinds = submits
      .map((event) => (event.payload as { recordKind: string }).recordKind)
      .sort();
    assert.deepEqual(kinds, ["task_summary", "verified_outcome", "workflow_candidate"]);
    assert.ok(
      submits.every(
        (event) => (event.payload as { origin?: string }).origin === "verified_experience",
      ),
    );
  } finally {
    await service.dispose();
  }
});

test("failed and unknown tool results do not submit executable experience", async () => {
  for (const scripted of [receipt("failed", "failure"), receipt("unknown", "unknown")]) {
    const emitted: Envelope[] = [];
    const runtime = new ScriptedRuntime([
      { kind: "tool.completed", receipt: scripted },
      { kind: "assistant.text_delta", text: "这一步没有验证通过。" },
      { kind: "turn.completed", taskId: "task_release" },
    ]);
    const service = new WorkerService({
      emit: (envelope) => emitted.push(envelope),
      createVoiceLoop: (emit) =>
        new VoiceLoop({
          runtime,
          emit,
          stt: new FakeSttProvider("继续"),
          tts: new FakeTtsProvider(),
        }),
    });
    try {
      await service.handle(
        request("voice.text.submit", {
          sessionId: "session_release",
          taskId: "task_release",
          cwd: "repo_semi",
          text: "打开资料页",
        }),
      );
      await waitFor(() => emitted.some((event) => event.kind === "voice.answer"));
      await waitFor(() => emitted.some((event) => event.kind === "voice.turn.completed"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        emitted.some((event) => event.kind === "memory.candidate.submit"),
        false,
        scripted.status,
      );
      assert.ok(emitted.findIndex((event) => event.kind === "voice.answer") >= 0);
    } finally {
      await service.dispose();
    }
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for experience persistence");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
