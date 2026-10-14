import { ProtocolValidationError } from "./envelope.ts";

export type CodingProvider = "pi" | "claude" | "codex";
export type WorkRole =
  "research" | "planning" | "review" | "implementation" | "integration" | "verification";
export type WorkStatus =
  "pending" | "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "unknown";
export type WorkflowStatus =
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "needs_revision"
  | "paused"
  | "cancelled"
  | "unknown";
export type AuthorizedAction = "read" | "workspace_write" | "local_commit" | "integrate";

/** 提案不可变。批准权只在 Host；角色不是 Provider，换执行者不改变任务的含义。 */
export interface WorkflowPlan {
  workflowId: string;
  sessionId: string;
  version: number;
  intentVersion: number;
  title: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  authorizedActions: AuthorizedAction[];
  repository: string;
  baselineCommit?: string;
  workItems: WorkItem[];
}
export interface WorkItem {
  workItemId: string;
  title: string;
  objective: string;
  role: WorkRole;
  provider: CodingProvider;
  dependencies: string[];
  outputs: string[];
  acceptance: string[];
}
export interface AgentRun {
  runId: string;
  workflowId: string;
  planVersion: number;
  intentVersion: number;
  workItemId: string;
  attempt: number;
  provider: CodingProvider;
  status: WorkStatus;
  workspace?: string;
  providerSessionId?: string;
  revision?: string;
  startedAtMs: number;
  endedAtMs?: number;
  summary?: string;
  error?: string;
  branch?: string;
  baselineCommit?: string;
  permission?: { requestId: string; tool: string; description: string };
  capabilities?: { steer: boolean; pause: boolean; resume: boolean };
}
export interface ReviewFinding {
  findingId: string;
  workItemId: string;
  revision: string;
  summary: string;
  status: "open" | "resolved" | "needs_user";
  reworkRounds: number;
}
export interface IntegrationResult {
  revision: string;
  branch: string;
  workspace: string;
  commits: string[];
  status: "unverified" | "conflict" | "verified";
  tests: Array<{ command: string; exitCode: number; revision: string; artifactId: string }>;
  reviews: Array<{ runId: string; revision: string; findingIds: string[] }>;
}
/** 独立用户授权，绑定源分支/HEAD 与已验证成果；实施计划不能代替此批准。 */
export interface WorkflowApplication {
  applicationId: string;
  workflowId: string;
  version: number;
  digest: string;
  repository: string;
  workspace: string;
  expectedRef: string;
  expectedHead: string;
  revision: string;
}
export function parseWorkflowApplication(value: unknown): WorkflowApplication {
  const raw = object(value);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(raw.digest))) invalid("invalid application digest");
  const expectedRef = text(raw.expectedRef);
  if (!expectedRef.startsWith("refs/heads/") || /[\s~^:?*[\\]/.test(expectedRef))
    invalid("invalid target branch");
  const commit = (value: unknown) => {
    const result = text(value, 64);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result)) invalid("invalid application revision");
    return result;
  };
  return {
    applicationId: id(raw.applicationId),
    workflowId: id(raw.workflowId),
    version: positive(raw.version),
    digest: String(raw.digest),
    repository: text(raw.repository, 4096),
    workspace: text(raw.workspace, 4096),
    expectedRef,
    expectedHead: commit(raw.expectedHead),
    revision: commit(raw.revision),
  };
}
export interface WorkflowEvent {
  eventId: string;
  sequence: number;
  kind: string;
  occurredAtMs: number;
  planVersion: number;
  intentVersion: number;
  summary: string;
}
export interface WorkflowSnapshot {
  plan: WorkflowPlan;
  digest: string;
  status: WorkflowStatus;
  runs: AgentRun[];
  events: WorkflowEvent[];
  findings?: ReviewFinding[];
  integration?: IntegrationResult;
  background?: {
    grant: {
      actor: "user";
      intentVersion: number;
      approvedPlanVersion: number;
      digest: string;
      repository: string;
      actions: AuthorizedAction[];
      approvedAtMs: number;
    } | null;
    coordinator: {
      executionStatus: "idle" | "coordinating" | "running" | "needs_user" | "completed";
      lastActivityAtMs: number;
      noProgress: number;
      reason: string | null;
    };
    requests: Array<{
      requestId: string;
      runId: string;
      kind: "clarification" | "plan";
      input: Record<string, unknown>;
      status: "pending" | "needs_user";
    }>;
  };
}

function invalid(message: string): never {
  throw new ProtocolValidationError(message, "invalid_payload");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("invalid workflow object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    invalid("invalid workflow text");
  return value;
}
function id(value: unknown): string {
  const result = text(value, 160);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid("invalid workflow identity");
  return result;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 4_294_967_295)
    invalid("invalid workflow version");
  return Number(value);
}
function list(value: unknown, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100)
    invalid("invalid workflow list");
  return value.map((item) => text(item));
}
export function isWritingRole(role: WorkRole): boolean {
  return role === "implementation" || role === "integration";
}

/** 跨进程先规范化，再校验 DAG；绝不靠模型“这是只读”来决定授权。 */
export function parseWorkflowPlan(value: unknown): WorkflowPlan {
  const raw = object(value);
  const keys = [
    "workflowId",
    "sessionId",
    "version",
    "intentVersion",
    "title",
    "goal",
    "scope",
    "acceptance",
    "authorizedActions",
    "repository",
    "baselineCommit",
    "workItems",
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid("unexpected plan field");
  if (!Array.isArray(raw.workItems) || !raw.workItems.length || raw.workItems.length > 100)
    invalid("invalid work items");
  const workItems = raw.workItems.map((value): WorkItem => {
    const item = object(value);
    if (
      Object.keys(item).some(
        (key) =>
          ![
            "workItemId",
            "title",
            "objective",
            "role",
            "provider",
            "dependencies",
            "outputs",
            "acceptance",
          ].includes(key),
      )
    )
      invalid("unexpected work item field");
    if (
      !["research", "planning", "review", "implementation", "integration", "verification"].includes(
        String(item.role),
      )
    )
      invalid("invalid work role");
    if (!["pi", "claude", "codex"].includes(String(item.provider)))
      invalid("invalid coding provider");
    return {
      workItemId: id(item.workItemId),
      title: text(item.title, 160),
      objective: text(item.objective),
      role: item.role as WorkRole,
      provider: item.provider as CodingProvider,
      dependencies: list(item.dependencies).map(id),
      outputs: list(item.outputs, 1),
      acceptance: list(item.acceptance, 1),
    };
  });
  const authorizedActions = list(raw.authorizedActions, 1) as AuthorizedAction[];
  if (
    new Set(authorizedActions).size !== authorizedActions.length ||
    authorizedActions.some(
      (action) => !["read", "workspace_write", "local_commit", "integrate"].includes(action),
    )
  )
    invalid("invalid authorized actions");
  if (
    !authorizedActions.includes("read") ||
    (workItems.some((item) => isWritingRole(item.role)) &&
      !authorizedActions.includes("workspace_write"))
  )
    invalid("writing task is outside authorization");
  if (authorizedActions.includes("integrate") && !authorizedActions.includes("local_commit"))
    invalid("integration requires local commit authorization");
  const repository = text(raw.repository, 4_096);
  if (!repository.startsWith("/") || repository.includes("\n"))
    invalid("repository must be an absolute local path");
  const baselineCommit =
    raw.baselineCommit === undefined ? undefined : text(raw.baselineCommit, 64);
  if (baselineCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baselineCommit))
    invalid("baseline must be an exact commit");
  const plan: WorkflowPlan = {
    workflowId: id(raw.workflowId),
    sessionId: id(raw.sessionId),
    version: positive(raw.version),
    intentVersion: positive(raw.intentVersion),
    title: text(raw.title, 160),
    goal: text(raw.goal),
    scope: list(raw.scope, 1),
    acceptance: list(raw.acceptance, 1),
    authorizedActions,
    repository,
    baselineCommit,
    workItems,
  };
  topologicalWorkItems(plan);
  return plan;
}

/** 稳定拓扑序仅处理依赖；调度器不在这里新增任务、分配角色或替 Pi 作决定。 */
export function topologicalWorkItems(plan: WorkflowPlan): WorkItem[] {
  const items = new Map(plan.workItems.map((item) => [item.workItemId, item]));
  if (items.size !== plan.workItems.length) invalid("duplicate work item");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: WorkItem[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) invalid("cyclic work dependencies");
    const item = items.get(id);
    if (!item) invalid("unknown work dependency");
    if (new Set(item.dependencies).size !== item.dependencies.length)
      invalid("duplicate work dependency");
    visiting.add(id);
    item.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
    result.push(item);
  }
  plan.workItems.forEach((item) => visit(item.workItemId));
  return result;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid("invalid workflow timestamp");
  return Number(value);
}
/** 进程、数据库和 UI 都使用同一校验；完成记录不可冒充当前计划的新成果。 */
export function parseAgentRun(value: unknown): AgentRun {
  const raw = object(value);
  if (
    ![
      "pending",
      "queued",
      "running",
      "blocked",
      "completed",
      "failed",
      "cancelled",
      "unknown",
    ].includes(String(raw.status))
  )
    invalid("invalid run status");
  if (!["pi", "claude", "codex"].includes(String(raw.provider))) invalid("invalid provider");
  const run: AgentRun = {
    runId: id(raw.runId),
    workflowId: id(raw.workflowId),
    workItemId: id(raw.workItemId),
    planVersion: positive(raw.planVersion),
    intentVersion: positive(raw.intentVersion),
    attempt: positive(raw.attempt),
    provider: raw.provider as CodingProvider,
    status: raw.status as WorkStatus,
    startedAtMs: timestamp(raw.startedAtMs),
  };
  for (const key of [
    "workspace",
    "providerSessionId",
    "revision",
    "summary",
    "error",
    "branch",
    "baselineCommit",
  ] as const) {
    if (raw[key] !== undefined) run[key] = text(raw[key], key === "summary" ? 32_000 : 8_000);
  }
  if (raw.endedAtMs !== undefined) run.endedAtMs = timestamp(raw.endedAtMs);
  if (run.endedAtMs !== undefined && run.endedAtMs < run.startedAtMs)
    invalid("run ends before it starts");
  for (const revision of [run.revision, run.baselineCommit]) {
    if (revision && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision))
      invalid("invalid run revision");
  }
  if (raw.permission !== undefined) {
    const permission = object(raw.permission);
    run.permission = {
      requestId: text(permission.requestId, 160),
      tool: text(permission.tool, 160),
      description: text(permission.description),
    };
  }
  if (raw.capabilities !== undefined) {
    const capabilities = object(raw.capabilities);
    if (["steer", "pause", "resume"].some((key) => typeof capabilities[key] !== "boolean"))
      invalid("invalid provider capabilities");
    run.capabilities = {
      steer: capabilities.steer as boolean,
      pause: capabilities.pause as boolean,
      resume: capabilities.resume as boolean,
    };
  }
  return run;
}
export function parseReviewFinding(value: unknown): ReviewFinding {
  const raw = object(value);
  if (
    !["open", "resolved", "needs_user"].includes(String(raw.status)) ||
    !Number.isSafeInteger(raw.reworkRounds) ||
    Number(raw.reworkRounds) < 0 ||
    Number(raw.reworkRounds) > 100
  )
    invalid("invalid review finding");
  const revision = text(raw.revision, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) invalid("invalid review revision");
  return {
    findingId: id(raw.findingId),
    workItemId: id(raw.workItemId),
    revision,
    summary: text(raw.summary),
    status: raw.status as ReviewFinding["status"],
    reworkRounds: Number(raw.reworkRounds),
  };
}
export function parseWorkflowSnapshot(value: unknown): WorkflowSnapshot {
  const raw = object(value);
  const plan = parseWorkflowPlan(raw.plan);
  if (
    typeof raw.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(raw.digest) ||
    ![
      "awaiting_approval",
      "approved",
      "rejected",
      "needs_revision",
      "paused",
      "cancelled",
      "unknown",
    ].includes(String(raw.status)) ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.runs)
  )
    invalid("invalid workflow snapshot metadata");
  const runs = raw.runs.map(parseAgentRun);
  if (runs.some((run) => run.workflowId !== plan.workflowId || run.planVersion > plan.version))
    invalid("run belongs to another workflow");
  const events = raw.events.map((value): WorkflowEvent => {
    const event = object(value);
    return {
      eventId: id(event.eventId),
      sequence: positive(event.sequence),
      kind: text(event.kind, 160),
      occurredAtMs: timestamp(event.occurredAtMs),
      planVersion: positive(event.planVersion),
      intentVersion: positive(event.intentVersion),
      summary: text(event.summary, 32_000),
    };
  });
  const findings =
    raw.findings === undefined
      ? []
      : Array.isArray(raw.findings)
        ? raw.findings.map(parseReviewFinding)
        : invalid("invalid findings");
  let background: WorkflowSnapshot["background"];
  if (raw.background !== undefined) {
    const entry = object(raw.background);
    const coordinator = object(entry.coordinator);
    if (
      !["idle", "coordinating", "running", "needs_user", "completed"].includes(
        String(coordinator.executionStatus),
      )
    )
      invalid("invalid coordinator state");
    const grant = entry.grant === null ? null : object(entry.grant);
    if (grant && (grant.actor !== "user" || !/^sha256:[a-f0-9]{64}$/.test(String(grant.digest))))
      invalid("invalid delegated grant");
    background = {
      coordinator: {
        executionStatus: coordinator.executionStatus as NonNullable<
          WorkflowSnapshot["background"]
        >["coordinator"]["executionStatus"],
        lastActivityAtMs: timestamp(coordinator.lastActivityAtMs),
        noProgress: timestamp(coordinator.noProgress),
        reason: coordinator.reason === null ? null : text(coordinator.reason),
      },
      grant: grant
        ? {
            actor: "user",
            intentVersion: positive(grant.intentVersion),
            approvedPlanVersion: positive(grant.approvedPlanVersion),
            digest: String(grant.digest),
            repository: text(grant.repository),
            actions: list(grant.actions).map((action) => {
              if (!["read", "workspace_write", "local_commit", "integrate"].includes(action))
                invalid("invalid grant action");
              return action as AuthorizedAction;
            }),
            approvedAtMs: timestamp(grant.approvedAtMs),
          }
        : null,
      requests: (entry.requests === undefined
        ? []
        : Array.isArray(entry.requests) && entry.requests.length <= 100
          ? entry.requests
          : invalid("invalid delegated requests")
      ).map((value) => {
        const request = object(value);
        if (
          !["clarification", "plan"].includes(String(request.kind)) ||
          !["pending", "needs_user"].includes(String(request.status))
        )
          invalid("invalid delegated request");
        const runId = id(request.runId);
        if (!runs.some((run) => run.runId === runId))
          invalid("decision belongs to another workflow");
        return {
          requestId: id(request.requestId),
          runId,
          kind: request.kind as "clarification" | "plan",
          input: object(request.input),
          status: request.status as "pending" | "needs_user",
        };
      }),
    };
  }
  return {
    plan,
    digest: raw.digest,
    status: raw.status as WorkflowStatus,
    runs,
    events,
    findings,
    ...(background ? { background } : {}),
    ...(raw.integration === undefined || raw.integration === null
      ? {}
      : { integration: parseIntegrationResult(raw.integration) }),
  };
}

export function parseIntegrationResult(value: unknown): IntegrationResult {
  const raw = object(value);
  const revision = text(raw.revision, 64);
  const commit = (value: unknown) => {
    const result = text(value, 64);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result)) invalid("invalid evidence revision");
    return result;
  };
  commit(revision);
  if (
    !["unverified", "conflict", "verified"].includes(String(raw.status)) ||
    !Array.isArray(raw.tests) ||
    !Array.isArray(raw.reviews) ||
    raw.tests.length > 100 ||
    raw.reviews.length > 100
  )
    invalid("invalid integration evidence");
  return {
    revision,
    branch: text(raw.branch),
    workspace: text(raw.workspace),
    commits: list(raw.commits).map(commit),
    status: raw.status as IntegrationResult["status"],
    tests: raw.tests.map((value) => {
      const test = object(value);
      if (!Number.isInteger(test.exitCode)) invalid("invalid test exit");
      return {
        command: text(test.command),
        exitCode: Number(test.exitCode),
        revision: commit(test.revision),
        artifactId: id(test.artifactId),
      };
    }),
    reviews: raw.reviews.map((value) => {
      const review = object(value);
      return {
        runId: id(review.runId),
        revision: commit(review.revision),
        findingIds: list(review.findingIds).map(id),
      };
    }),
  };
}
