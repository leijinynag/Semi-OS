export * from "./generated/domain.generated.js";
export * from "./domain-events.js";

import type { TaskId, TaskRunId, TraceId } from "./generated/domain.generated.js";

export interface DomainContext {
  taskId?: TaskId;
  taskRunId?: TaskRunId;
  traceId?: TraceId;
}
