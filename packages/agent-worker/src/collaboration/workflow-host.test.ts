import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope, RequestId } from "@semi-os/protocol";
import { WorkflowHost } from "./workflow-host.ts";

test("transport retries keep their identity and cannot replace a pending request", async () => {
  const events: Envelope[] = [];
  const host = new WorkflowHost((event) => events.push(event));
  const id = "req_retry_fixture" as RequestId;
  const controller = new AbortController();
  const first = host.request("find", {}, controller.signal, id);
  assert.throws(() => host.request("find", {}, controller.signal, id), /already pending/);
  host.acknowledge({ operationId: id, ok: true, value: [] });
  assert.deepEqual(await first, []);
  const retry = host.request("find", {}, controller.signal, id);
  host.acknowledge({ operationId: id, ok: true, value: [] });
  assert.deepEqual(await retry, []);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.requestId === id));
  host.dispose();
});

test("cancelled requests release identity without accepting unrelated acknowledgements", async () => {
  const host = new WorkflowHost(() => {});
  const controller = new AbortController();
  const id = "req_cancel_fixture" as RequestId;
  const pending = host.request("find", {}, controller.signal, id);
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort();
  await rejected;
  host.acknowledge({ operationId: id, ok: true, value: "late" });
  const next = host.request("find", {}, new AbortController().signal, id);
  host.acknowledge({ operationId: id, ok: true, value: "current" });
  assert.equal(await next, "current");
  host.dispose();
});
