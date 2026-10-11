import test from "node:test";
import assert from "node:assert/strict";
import { ResearchHost } from "./research-host.ts";
import type { Envelope, ResearchReport } from "@semi-os/protocol";

const report: ResearchReport = { taskId: "t", summary: "结果", claims: [], limitations: [] };
test("requires correlated durable Host acknowledgement and cleans up cancellation", async () => {
  const events: Envelope[] = [];
  const host = new ResearchHost((event) => events.push(event));
  const controller = new AbortController();
  const pending = host.report(report, controller.signal);
  const event = events[0]!;
  host.acknowledge({ operationId: "unrelated", ok: true });
  host.acknowledge({ operationId: event.requestId, ok: true });
  await pending;
  const cancelled = host.report(report, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  const rejected = host.report(report, new AbortController().signal);
  host.acknowledge({ operationId: events.at(-1)!.requestId, ok: false, error: "invalid citation" });
  await assert.rejects(rejected, /invalid citation/);
  host.dispose();
});
