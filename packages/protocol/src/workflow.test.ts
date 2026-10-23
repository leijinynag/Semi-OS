import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isIntegrationWorkItem,
  isWritingWorkItem,
  parseAgentRun,
  parseWorkflowPlan,
  parseWorkflowApplication,
  topologicalWorkItems,
} from "./workflow.ts";
import { readFileSync } from "node:fs";

const plan = () => ({
  workflowId: "workflow_test",
  sessionId: "session_test",
  version: 1,
  intentVersion: 1,
  title: "合成项目",
  goal: "实现计数器",
  scope: ["src"],
  acceptance: ["单测通过"],
  repository: "/tmp/synthetic",
  authorizedActions: ["read", "workspace_write"],
  workItems: [
    {
      workItemId: "implement",
      title: "实施",
      objective: "写计数器",
      role: "implementation",
      provider: "pi",
      dependencies: [],
      outputs: ["diff"],
      acceptance: ["通过单测"],
    },
    {
      workItemId: "review",
      title: "审查",
      objective: "独立审查",
      role: "review",
      provider: "codex",
      dependencies: ["implement"],
      outputs: ["findings"],
      acceptance: ["版本明确"],
    },
  ],
});
test("normalizes a plan and preserves provider/role separation", () => {
  const parsed = parseWorkflowPlan(plan());
  assert.deepEqual(
    topologicalWorkItems(parsed).map((item) => item.workItemId),
    ["implement", "review"],
  );
  const implementation = parsed.workItems.find((item) => item.workItemId === "implement");
  assert.ok(implementation);
  assert.equal(isWritingWorkItem(implementation), true);
  assert.equal(implementation.isolation, "isolated_worktree");
  assert.deepEqual(implementation.capabilities, [
    "read:repo",
    "read:files",
    "write:workspace:isolated",
  ]);
  const review = parsed.workItems.find((item) => item.workItemId === "review")!;
  assert.deepEqual(review.evidence, {
    revision: true,
    tests: false,
    independentReview: true,
  });
});
test("explicitly disabled evidence does not inherit legacy review defaults", () => {
  const raw = plan();
  const parsed = parseWorkflowPlan({
    ...raw,
    workItems: [
      raw.workItems[0],
      {
        ...raw.workItems[1],
        evidence: { revision: false, tests: false, independentReview: false },
      },
    ],
  });
  assert.deepEqual(parsed.workItems[1]!.evidence, {
    revision: false,
    tests: false,
    independentReview: false,
  });
});
test("rejects cycles, unknown/duplicate identities and missing authorization", () => {
  const cyclic = plan();
  cyclic.workItems[0]!.dependencies = ["review"];
  assert.throws(() => parseWorkflowPlan(cyclic), /cyclic/);
  const unknown = plan();
  unknown.workItems[1]!.dependencies = ["missing"];
  assert.throws(() => parseWorkflowPlan(unknown), /unknown/);
  const duplicate = plan();
  duplicate.workItems[1]!.workItemId = "implement";
  assert.throws(() => parseWorkflowPlan(duplicate), /duplicate/);
  const unauthorized = plan();
  unauthorized.authorizedActions = ["read"];
  assert.throws(() => parseWorkflowPlan(unauthorized), /authorization/);
});
test("rejects arbitrary baseline refs and unsafe repository identity", () => {
  assert.throws(() => parseWorkflowPlan({ ...plan(), baselineCommit: "main" }), /exact commit/);
  assert.throws(
    () => parseWorkflowPlan({ ...plan(), repository: "../user-repository" }),
    /absolute/,
  );
  assert.throws(() => parseWorkflowPlan({ ...plan(), version: 0 }), /version/);
});
test("shares the Rust plan fixture and rejects embedded approval", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../tests/contract/fixtures/workflow-plan.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(parseWorkflowPlan(fixture).workItems.length, 2);
  assert.throws(() => parseWorkflowPlan({ ...fixture, approved: true }), /unexpected/);
});
test("accepts explicit capabilities, evidence and execution budget", () => {
  const explicit = {
    ...plan(),
    authorizedActions: ["read", "workspace_write", "local_commit"],
    authorizedCapabilities: [
      "read:repo",
      "read:files",
      "read:evidence",
      "write:workspace:isolated",
      "run:test",
      "git:commit:local",
    ],
    executionBudget: {
      maxParallelRuns: 4,
      maxReworkRounds: 5,
      maxNoProgressTurns: 6,
    },
    workItems: [
      {
        ...plan().workItems[0],
        capabilities: ["read:repo", "read:files", "write:workspace:isolated"],
        isolation: "isolated_worktree",
        evidence: { revision: true, tests: true, independentReview: false },
      },
      {
        ...plan().workItems[1],
        role: "integration",
        capabilities: ["read:repo", "read:files", "read:evidence", "run:test", "git:commit:local"],
        isolation: "none",
        evidence: { revision: true, tests: true, independentReview: true },
      },
    ],
  };
  const parsed = parseWorkflowPlan(explicit);
  assert.deepEqual(parsed.executionBudget, {
    maxParallelRuns: 4,
    maxReworkRounds: 5,
    maxNoProgressTurns: 6,
  });
  assert.equal(isIntegrationWorkItem(parsed.workItems[1]!), true);
});
test("rejects invalid capability, isolation and budget combinations", () => {
  assert.throws(
    () =>
      parseWorkflowPlan({
        ...plan(),
        workItems: [{ ...plan().workItems[0], capabilities: ["not-a-capability"] }],
      }),
    /capabilities/,
  );
  assert.throws(
    () =>
      parseWorkflowPlan({
        ...plan(),
        workItems: [
          {
            ...plan().workItems[0],
            capabilities: ["read:repo", "read:files", "write:workspace:isolated"],
            isolation: "none",
          },
        ],
      }),
    /isolated worktree/,
  );
  assert.throws(
    () => parseWorkflowPlan({ ...plan(), executionBudget: { maxParallelRuns: 0 } }),
    /execution budget/,
  );
});
test("requires integration evidence for the integration capability set", () => {
  assert.throws(
    () =>
      parseWorkflowPlan({
        ...plan(),
        authorizedActions: ["read", "workspace_write", "local_commit", "integrate"],
        authorizedCapabilities: [
          "read:repo",
          "read:files",
          "read:evidence",
          "write:workspace:isolated",
          "run:test",
          "git:commit:local",
        ],
        workItems: [
          {
            ...plan().workItems[0],
            role: "integration",
            capabilities: [
              "read:repo",
              "read:files",
              "read:evidence",
              "run:test",
              "git:commit:local",
            ],
            isolation: "none",
            evidence: { revision: true, tests: true, independentReview: false },
          },
        ],
      }),
    /independent review|capability set/,
  );
});
test("validates actual Provider capabilities without inferring from its name", () => {
  const run = {
    runId: "run",
    workflowId: "workflow",
    workItemId: "item",
    planVersion: 1,
    intentVersion: 1,
    attempt: 1,
    provider: "claude",
    status: "running",
    startedAtMs: 1,
    capabilities: { steer: false, pause: false, resume: true },
  };
  assert.equal(parseAgentRun(run).capabilities?.steer, false);
  assert.throws(
    () => parseAgentRun({ ...run, capabilities: { ...run.capabilities, steer: "true" } }),
    /capabilities/,
  );
});
test("source application requires an exact version, branch and commit-bound authorization", () => {
  const request = {
    applicationId: "apply_test",
    workflowId: "workflow_test",
    version: 1,
    digest: `sha256:${"a".repeat(64)}`,
    repository: "/tmp/source",
    workspace: "/tmp/integration",
    expectedRef: "refs/heads/main",
    expectedHead: "b".repeat(40),
    revision: "c".repeat(40),
  };
  assert.deepEqual(parseWorkflowApplication(request), request);
  assert.throws(() => parseWorkflowApplication({ ...request, digest: "approved" }), /digest/);
  assert.throws(() => parseWorkflowApplication({ ...request, expectedRef: "HEAD" }), /branch/);
  assert.throws(() => parseWorkflowApplication({ ...request, expectedHead: "main" }), /revision/);
  assert.throws(() => parseWorkflowApplication({ ...request, version: 0 }), /version/);
});
