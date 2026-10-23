import type { JsonObject, ToolDefinition } from "@semi-os/tool-sdk";
import type { JsonValue, WorkflowSnapshot } from "@semi-os/protocol";
import type { WorkflowHost } from "./workflow-host.ts";
import type { CollaborationService } from "./service.ts";

const string = { type: "string", minLength: 1 };
const list = { type: "array", items: string };
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const hostMutationContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: false, freshness: "best_effort" },
  mutation: { kind: "workspace", atomic: true },
  verification: { required: true, method: "host" },
  reversibility: "partially_reversible",
  idempotency: "keyed",
  reconciliation: "safe",
};
const providerMutationContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: true, freshness: "fresh" },
  mutation: { kind: "external", atomic: true },
  verification: { required: true, method: "host" },
  reversibility: "partially_reversible",
  idempotency: "keyed",
  // Provider 会话可能已经接受请求，当前工具没有自动对账实现。
  reconciliation: "unsupported",
};
const workItem = {
  type: "object",
  additionalProperties: false,
  required: [
    "workItemId",
    "title",
    "objective",
    "role",
    "provider",
    "dependencies",
    "outputs",
    "acceptance",
  ],
  properties: {
    workItemId: string,
    title: string,
    objective: string,
    role: {
      enum: ["research", "planning", "review", "implementation", "integration", "verification"],
    },
    provider: { enum: ["pi", "claude", "codex"] },
    dependencies: list,
    outputs: list,
    acceptance: list,
  },
};
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "workflowId",
    "version",
    "intentVersion",
    "title",
    "goal",
    "scope",
    "acceptance",
    "authorizedActions",
    "repository",
    "workItems",
  ],
  properties: {
    workflowId: string,
    version: { type: "integer", minimum: 1 },
    intentVersion: { type: "integer", minimum: 1 },
    title: string,
    goal: string,
    scope: list,
    acceptance: list,
    repository: string,
    baselineCommit: string,
    authorizedActions: {
      type: "array",
      items: { enum: ["read", "workspace_write", "local_commit", "integrate"] },
    },
    workItems: { type: "array", items: workItem, minItems: 1, maxItems: 100 },
  },
};

/** 后台使用同一套注册工具，但只有所属工作流可见、可变更。 */
export function createCoordinatorTools(
  host: WorkflowHost,
  snapshot: WorkflowSnapshot,
  service: CollaborationService,
): ToolDefinition[] {
  return createWorkflowTools(host, snapshot.plan.sessionId, service)
    .filter((tool) => !["workflow_submit_plan", "workflow_find"].includes(tool.name))
    .map((tool) => ({
      ...tool,
      execute: async (input, context) => {
        if (input.workflowId !== undefined && input.workflowId !== snapshot.plan.workflowId)
          throw new Error("后台协调不可跨工作流修改");
        if (tool.name === "workflow_steer") {
          const current = (await host.list(snapshot.plan.sessionId, context.signal)).find(
            (item) => item.plan.workflowId === snapshot.plan.workflowId,
          );
          if (!current?.runs.some((run) => run.runId === input.runId))
            throw new Error("追加指令不属于当前工作流");
        }
        if (tool.name === "workflow_observe") {
          const workflows = await host.list(snapshot.plan.sessionId, context.signal);
          return {
            output: {
              workflows: JSON.parse(
                JSON.stringify(
                  workflows.filter((item) => item.plan.workflowId === snapshot.plan.workflowId),
                ),
              ),
            },
            outputSummary: "当前工作流快照",
          };
        }
        return tool.execute(input, context);
      },
    }));
}

/** 主 Pi 提案/观察，客户端用户批准；工具不等待批准阻塞整轮对话。 */
export function createWorkflowTools(
  host: WorkflowHost,
  sessionId: string,
  service?: CollaborationService,
): ToolDefinition[] {
  return [
    {
      name: "workflow_find",
      description:
        "跨 Session 查找后台任务。按名称、仓库、批准状态或后台执行状态（running/completed/needs_user）过滤；多项匹配时询问用户，不猜测任务。",
      riskLevel: "read",
      requiredCapabilities: ["collaboration"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { name: string, repository: string, status: string },
      },
      execute: async (input, context) => ({
        output: { workflows: await host.request("find", json(input), context.signal) },
        outputSummary: "真实任务及进度已返回",
      }),
      verify: async () => ({
        status: "passed",
        method: "host_cross_session_snapshot",
        summary: "未改变后台执行",
        evidence: [],
      }),
    },
    {
      name: "workflow_submit_plan",
      description:
        "向用户提交版本化多 Agent 计划。首次 version=1/intentVersion=1，新目标/范围/授权变更同时递增两者。提交后等待用户批准，不能自行启动实施。",
      riskLevel: "local_write",
      requiredCapabilities: ["collaboration"],
      contract: hostMutationContract,
      inputSchema: planSchema,
      execute: async (input, context) => {
        if (service && input.version !== 1) {
          const snapshots = await host.list(sessionId, context.signal);
          if (!snapshots.some((snapshot) => snapshot.plan.workflowId === input.workflowId))
            throw new Error("工作流不属于当前会话");
          // 先关旧门控再保存新意图，不能等待模型下一次派单才停止在途子任务。
          await service.stopWorkflow(String(input.workflowId));
        }
        const snapshot = await host.submit({ ...input, sessionId }, context.signal);
        return {
          output: JSON.parse(JSON.stringify(snapshot)) as JsonObject,
          outputSummary: "计划已保存，等待用户批准",
        };
      },
      verify: async () => ({
        status: "passed",
        method: "host_plan_persistence",
        summary: "Host 已确认计划持久化，不代表已批准或已实施",
        evidence: [],
      }),
    },
    {
      name: "workflow_refine_plan",
      description:
        "已批准边界内换执行者/细分任务/增加审查；只递增 version，intentVersion 与目标/范围/验收/仓库/授权保持不变。先停止或核对未结束尝试。",
      riskLevel: "local_write",
      requiredCapabilities: ["collaboration"],
      contract: hostMutationContract,
      inputSchema: planSchema,
      execute: async (input, context) => ({
        output: JSON.parse(
          JSON.stringify(await host.refine({ ...input, sessionId }, context.signal)),
        ),
        outputSummary: "范围内计划调整已由 Host 校验并保存",
      }),
      verify: async () => ({
        status: "passed",
        method: "host_refinement",
        summary: "授权边界未改变，调整留痕",
        evidence: [],
      }),
    },
    {
      name: "workflow_observe",
      description: "读取当前会话的协作计划、批准状态、执行尝试及时间线。",
      riskLevel: "read",
      requiredCapabilities: ["collaboration"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => ({
        output: {
          workflows: JSON.parse(JSON.stringify(await host.list(sessionId, context.signal))),
        },
        outputSummary: "已读取 Host 协作快照",
      }),
      verify: async () => ({
        status: "passed",
        method: "host_snapshot",
        summary: "结构化快照已返回",
        evidence: [],
      }),
    },
    ...(service
      ? [
          {
            name: "workflow_decide_request",
            description:
              "回答已登记的子 Agent 实现细节或审查范围内子计划。必须根据批准计划；涉及偏好、目标变化或新增权限使用 needs_user，不能代替真人总计划批准。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: hostMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "runId", "requestId", "kind", "decision"],
              properties: {
                workflowId: string,
                runId: string,
                requestId: string,
                kind: { enum: ["clarification", "plan"] },
                decision: {
                  type: "object",
                  additionalProperties: false,
                  required: ["authority", "reason"],
                  properties: {
                    authority: { enum: ["implementation_detail", "needs_user"] },
                    reason: string,
                    approved: { type: "boolean" },
                    answers: { type: "object", additionalProperties: { type: "string" } },
                  },
                },
              },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: JSON.parse(
                JSON.stringify(
                  await service.decideRequest(
                    sessionId,
                    String(input.workflowId),
                    String(input.runId),
                    String(input.requestId),
                    String(input.kind),
                    json(input.decision),
                    context.signal,
                  ),
                ),
              ),
              outputSummary: "代理决策已由 Host 核对并留痕",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_delegated_decision",
              summary: "不扩大用户授权",
              evidence: [],
            }),
          },
          {
            name: "workflow_stop",
            description:
              "先由 Host 持久化暂停，再停止工作流的在途及排队尝试。保留现场；只能降低权限，恢复需用户操作。范围内追加指令优先用 steer，不能用暂停冒充完成。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: providerMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId"],
              properties: { workflowId: string },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => {
              const snapshots = await host.list(sessionId, context.signal);
              if (!snapshots.some((snapshot) => snapshot.plan.workflowId === input.workflowId))
                throw new Error("工作流不属于当前会话");
              await host.request(
                "suspend",
                { workflowId: String(input.workflowId) },
                context.signal,
              );
              await service.stopWorkflow(String(input.workflowId));
              return { output: { stopped: true }, outputSummary: "新操作已停止，成果保留" };
            },
            verify: async () => ({
              status: "passed" as const,
              method: "execution_gate_closed",
              summary: "子任务停止，不代表已验收",
              evidence: [],
            }),
          },
          {
            name: "workflow_resume_run",
            description:
              "从已停止/失败且工作区干净的旧尝试续接 Provider 会话，登记新尝试与独立工作区。unknown 需用户先核对；脏成果需处理，不能盲重试。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: providerMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "workItemId", "runId"],
              properties: { workflowId: string, workItemId: string, runId: string },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: {
                run: JSON.parse(
                  JSON.stringify(
                    await service.dispatch(
                      sessionId,
                      String(input.workflowId),
                      String(input.workItemId),
                      context.signal,
                      String(input.runId),
                    ),
                  ),
                ),
              },
              outputSummary: "续接尝试已登记，旧成果记录保留",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_resume_registration",
              summary: "仅证明新尝试已保存，不代表恢复完成或验收",
              evidence: [],
            }),
          },
          {
            name: "workflow_test",
            description:
              "对已交付整合提交运行测试。已授权且可用的受限沙箱自动执行；无法约束的命令仍须用户确认。返回真实退出码与 Artifact，修改受版本控制内容使证据失效。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: hostMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "runId", "command"],
              properties: { workflowId: string, runId: string, command: string },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: {
                test: await service.test(
                  sessionId,
                  String(input.workflowId),
                  String(input.runId),
                  String(input.command),
                  context.signal,
                ),
              },
              outputSummary: "真实测试结果已保存；请检查退出码",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_test_artifact",
              summary: "验证命令执行和证据保存，不代表测试通过",
              evidence: [],
            }),
          },
          {
            name: "workflow_record_finding",
            description:
              "记录与已交付版本对应的审查问题；同一 findingId 返工次数逐轮递增，三轮未解决需要用户决策。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: hostMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "finding"],
              properties: {
                workflowId: string,
                finding: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "findingId",
                    "workItemId",
                    "revision",
                    "summary",
                    "status",
                    "reworkRounds",
                  ],
                  properties: {
                    findingId: string,
                    workItemId: string,
                    revision: string,
                    summary: string,
                    status: { enum: ["open", "resolved", "needs_user"] },
                    reworkRounds: { type: "integer", minimum: 0, maximum: 100 },
                  },
                },
              },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: JSON.parse(
                JSON.stringify(
                  await service.recordFinding(
                    sessionId,
                    String(input.workflowId),
                    input.finding,
                    context.signal,
                  ),
                ),
              ),
              outputSummary: "审查问题与返工历史已保存",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_review_persistence",
              summary: "仅证明记录保存，不替代独立审查",
              evidence: [],
            }),
          },
          {
            name: "workflow_record_integration",
            description:
              "保存整合结果。verified 必须有当前提交的真实测试 Artifact、独立审查尝试、无未解决问题；改动后旧证据不可复用。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: hostMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "result"],
              properties: {
                workflowId: string,
                result: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "revision",
                    "branch",
                    "workspace",
                    "commits",
                    "status",
                    "tests",
                    "reviews",
                  ],
                  properties: {
                    revision: string,
                    branch: string,
                    workspace: string,
                    commits: list,
                    status: { enum: ["unverified", "conflict", "verified"] },
                    tests: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["command", "exitCode", "revision", "artifactId"],
                        properties: {
                          command: string,
                          exitCode: { type: "integer" },
                          revision: string,
                          artifactId: string,
                        },
                        additionalProperties: false,
                      },
                    },
                    reviews: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["runId", "revision", "findingIds"],
                        properties: { runId: string, revision: string, findingIds: list },
                        additionalProperties: false,
                      },
                    },
                  },
                },
              },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: JSON.parse(
                JSON.stringify(
                  await service.recordIntegration(
                    sessionId,
                    String(input.workflowId),
                    input.result,
                    context.signal,
                  ),
                ),
              ),
              outputSummary: "版本绑定的整合结果已由 Host 保存",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_integration_evidence",
              summary: "结果持久化，不会将 unverified 转成 verified",
              evidence: [],
            }),
          },
          {
            name: "workflow_dispatch",
            description:
              "派发一个计划内工作项；Host 检查批准/依赖，最多两个子 Agent，其余排队。完成不代表验收通过。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: providerMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["workflowId", "workItemId"],
              properties: { workflowId: string, workItemId: string },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => ({
              output: {
                run: JSON.parse(
                  JSON.stringify(
                    await service.dispatch(
                      sessionId,
                      String(input.workflowId),
                      String(input.workItemId),
                      context.signal,
                    ),
                  ),
                ),
              },
              outputSummary: "工作项已登记排队；请观察真实结果",
            }),
            verify: async () => ({
              status: "passed" as const,
              method: "host_run_persistence",
              summary: "执行登记已保存，尚未完成或验收",
              evidence: [],
            }),
          },
          {
            name: "workflow_steer",
            description:
              "向正在执行的子 Agent 追加范围内指令；不支持 steer 的 Provider 明确报错。目标变化请先要求用户重新批准。",
            riskLevel: "local_write" as const,
            requiredCapabilities: ["collaboration"],
            contract: providerMutationContract,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["runId", "text"],
              properties: { runId: string, text: string },
            },
            execute: async (
              input: JsonObject,
              context: Parameters<ToolDefinition["execute"]>[1],
            ) => {
              const snapshots = await host.list(sessionId, context.signal);
              if (
                !snapshots.some((snapshot) =>
                  snapshot.runs.some((run) => run.runId === input.runId),
                )
              )
                throw new Error("执行不属于当前会话");
              await service.steer(String(input.runId), String(input.text));
              return { output: { accepted: true }, outputSummary: "已发送追加指令" };
            },
            verify: async () => ({
              status: "passed" as const,
              method: "provider_delivery",
              summary: "发送与事件保存成功，仅验证指令交付，不代表执行或验收",
              evidence: [],
            }),
          },
        ]
      : []),
  ];
}
