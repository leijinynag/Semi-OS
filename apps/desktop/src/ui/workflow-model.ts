import type { WorkflowSnapshot } from "@semi-os/protocol";

/** 每个工作流独立比较版本与事件序号，迟到的初始读取不能覆盖实时批准。 */
export function mergeWorkflowSnapshots(
  current: WorkflowSnapshot[],
  incoming: WorkflowSnapshot[],
): WorkflowSnapshot[] {
  const merged = new Map(current.map((item) => [item.plan.workflowId, item]));
  for (const item of incoming) {
    const old = merged.get(item.plan.workflowId);
    if (
      !old ||
      item.plan.version > old.plan.version ||
      (item.plan.version === old.plan.version &&
        (item.events.at(-1)?.sequence ?? 0) >= (old.events.at(-1)?.sequence ?? 0))
    ) {
      merged.set(item.plan.workflowId, item);
    }
  }
  return [...merged.values()];
}
