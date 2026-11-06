import test from "node:test";
import assert from "node:assert/strict";
import type { Envelope, RequestId } from "@semi-os/protocol";
import { MemoryCandidateHost, buildStructuredMemoryCandidate } from "./memory-candidate.ts";
import { WorkerService } from "./worker-service.ts";

test("structured builder emits all required candidate fields", () => {
  const payload = buildStructuredMemoryCandidate({
    memoryId: "mem_pref_editor",
    recordKind: "preference",
    key: "editor",
    value: "use rustfmt",
    scope: { userId: "user_eval", workspaceId: "repo_eval" },
    sourceRef: "turn_pref_1",
    origin: "conversation_turn",
  });
  assert.equal(payload.memoryId, "mem_pref_editor");
  assert.equal(payload.recordKind, "preference");
  assert.equal(payload.layer, "L2");
  assert.deepEqual(payload.content, {
    kind: "preference",
    key: "editor",
    value: "use rustfmt",
  });
  assert.deepEqual(payload.scope, { userId: "user_eval", workspaceId: "repo_eval" });
  assert.equal(payload.confidence, 90);
  assert.equal(payload.importance, 70);
  assert.equal(payload.sourceRefs[0]?.sourceRef, "turn_pref_1");
  assert.equal(payload.conflictTarget, null);
  assert.equal(payload.origin, "conversation_turn");
});

test("submits a candidate and waits for an explicit Host result", async () => {
  const events: Envelope[] = [];
  const host = new MemoryCandidateHost((event) => events.push(event));
  const pending = host.submit(
    buildStructuredMemoryCandidate({
      memoryId: "mem_fact_bakery",
      recordKind: "project_fact",
      fact: "面包房清晨出炉 sourdough",
      sourceRef: "turn_fact_1",
      origin: "conversation_turn",
    }),
    new AbortController().signal,
  );
  const submitted = events[0];
  assert.equal(submitted?.kind, "memory.candidate.submit");
  assert.equal(submitted?.direction, "event");
  const payload = submitted?.payload as { operationId?: string; origin?: string };
  assert.equal(typeof payload.operationId, "string");
  assert.equal(payload.origin, "conversation_turn");
  host.receiveResult({
    operationId: "unrelated",
    status: "stored",
    memoryId: "other",
  });
  host.receiveResult({
    operationId: payload.operationId!,
    status: "stored",
    memoryId: "mem_fact_bakery",
  });
  const result = await pending;
  assert.equal(result.status, "stored");
  assert.equal(result.memoryId, "mem_fact_bakery");

  const rejected = host.submit(
    buildStructuredMemoryCandidate({
      memoryId: "mem_pref_editor",
      recordKind: "preference",
      key: "editor",
      value: "use rustfmt",
      sourceRef: "turn_pref_1",
      origin: "conversation_turn",
    }),
    new AbortController().signal,
  );
  const rejectedId = (events.at(-1)?.payload as { operationId: string }).operationId;
  host.receiveResult({
    operationId: rejectedId,
    status: "rejected",
    reason: "missing_field:origin",
  });
  await assert.rejects(rejected, /missing_field:origin/);
  host.dispose();
});

test("WorkerService submits then receives an explicit result", async () => {
  const emitted: Envelope[] = [];
  const service = new WorkerService({
    emit: (message) => emitted.push(message),
    createVoiceLoop: () => ({
      async run() {},
      async interrupt() {},
      async dispose() {},
    }),
  });
  try {
    const pending = service.submitStructuredMemoryCandidate(
      {
        memoryId: "mem_pref_editor",
        recordKind: "preference",
        key: "editor",
        value: "use rustfmt",
        scope: { userId: "user_eval" },
        sourceRef: "turn_pref_1",
        origin: "conversation_turn",
      },
      new AbortController().signal,
    );
    const submit = emitted.find((event) => event.kind === "memory.candidate.submit");
    assert.ok(submit);
    const operationId = (submit?.payload as { operationId: string }).operationId;
    const response = await service.handle({
      direction: "request",
      protocolVersion: 1,
      requestId: operationId as RequestId,
      kind: "memory.candidate.result",
      payload: {
        operationId,
        status: "stored",
        memoryId: "mem_pref_editor",
      },
    });
    assert.equal(response.kind, "memory.candidate.received");
    const result = await pending;
    assert.equal(result.status, "stored");
    assert.equal(result.memoryId, "mem_pref_editor");
  } finally {
    await service.dispose();
  }
});
