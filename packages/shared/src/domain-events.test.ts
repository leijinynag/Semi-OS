import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import {
  assertDomainEvent,
  DomainEventValidationError,
} from "./domain-events.ts";

test("shared domain event fixture matches the TypeScript contract", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      resolve(process.cwd(), "../../tests/contract/fixtures/domain-event.json"),
      "utf8",
    ),
  );
  assertDomainEvent(fixture);

  assert.equal(fixture.kind, "task.lifecycle_changed");
  if (fixture.kind === "task.lifecycle_changed") {
    assert.equal(fixture.from, "understanding");
    assert.equal(fixture.to, "running");
  }
});

test("rejects unknown or incomplete domain events at runtime", () => {
  assert.throws(
    () =>
      assertDomainEvent({
        eventId: "evt_bad",
        taskId: "task_bad",
        taskRunId: "run_bad",
        traceId: "trace_bad",
        occurredAtMs: 100,
        kind: "assistant.claimed_success",
      }),
    DomainEventValidationError,
  );
});
