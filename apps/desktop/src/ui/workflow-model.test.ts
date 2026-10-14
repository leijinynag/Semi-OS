import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowSnapshot } from "@semi-os/protocol";
import { mergeWorkflowSnapshots } from "./workflow-model.ts";

function snapshot(id: string, version: number, sequence: number): WorkflowSnapshot {
  return { plan: { workflowId: id, version }, events: [{ sequence }] } as WorkflowSnapshot;
}

test("late initial snapshots cannot overwrite current workflow versions or sequences", () => {
  const latest = snapshot("a", 2, 20);
  const result = mergeWorkflowSnapshots([latest], [snapshot("a", 1, 99), snapshot("b", 1, 1)]);
  assert.equal(result[0], latest);
  assert.equal(result.length, 2);
  assert.equal(mergeWorkflowSnapshots([latest], [snapshot("a", 2, 19)])[0], latest);
  assert.equal(mergeWorkflowSnapshots([latest], [snapshot("a", 3, 1)])[0]?.plan.version, 3);
});
