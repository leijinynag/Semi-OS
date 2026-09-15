export * from "./generated/domain.generated.js";

import type { TaskId, TaskRunId, TraceId } from "./generated/domain.generated.js";

export interface DomainContext {
  taskId?: TaskId;
  taskRunId?: TaskRunId;
  traceId?: TraceId;
}
