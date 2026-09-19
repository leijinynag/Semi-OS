import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  type ResourceLoader,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  PolicyDecision,
  ToolRiskLevel,
  VerificationRecord,
} from "@semi-os/shared";
import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionReceipt,
} from "@semi-os/tool-sdk";
import { Type } from "typebox";
import {
  AgentRuntimeStateError,
  EventedAgentRuntime,
  type AgentCheckpoint,
  type AgentFollowUp,
  type AgentPrompt,
  type AgentSessionHandle,
  type AgentSteering,
  type PauseResult,
  type StartSessionInput,
} from "./runtime.ts";
import {
  digestToolInput,
  executeProductTool,
  ToolExecutionError,
  type ToolAttemptIdentity,
} from "./tool-execution.ts";

interface ToolPolicySubject {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
}

/**
 * 创建 Pi SessionManager 时同时传入产品 checkpoint。
 *
 * checkpoint 属于 Semi-OS 的稳定协议，SessionManager 属于 Pi 的实现细节；
 * 这个窄接口把二者的转换限制在当前适配器中，也方便测试替换真实持久化层。
 */
interface CreatePiSessionManagerInput {
  cwd: string;
  checkpoint?: AgentCheckpoint;
}

/**
 * ResourceLoader 是接入 Pi 官方扩展机制的入口。
 *
 * Semi-OS 不替换 Pi 原生工具实现，而是通过注入的隐藏扩展监听工具生命周期，
 * 从而在原生工具外层补上产品所需的策略、审计和验证。
 */
interface CreatePiResourceLoaderInput {
  cwd: string;
  extension: InlineExtension;
}

/**
 * Pi Runtime 的依赖注入点。
 *
 * 生产环境使用 Pi 官方实现；测试可以替换时钟、Session、ResourceLoader 和
 * 策略解析器，在不启动真实模型或读写用户会话的情况下验证适配器行为。
 */
export interface PiAgentRuntimeOptions {
  now?: () => number;
  createSession?: typeof createAgentSession;
  baseToolNames?: readonly string[];
  sessionDir?: string;
  createSessionManager?: (
    input: CreatePiSessionManagerInput,
  ) => SessionManager;
  createResourceLoader?: (
    input: CreatePiResourceLoaderInput,
  ) => ResourceLoader;
  resolvePolicyDecision?: (
    tool: ToolPolicySubject,
    input: JsonObject,
    taskId: string,
  ) => Promise<PolicyDecision>;
}

function asJsonObject(value: unknown): JsonObject {
  // Pi 扩展事件来自 SDK 边界，不能因为 TypeScript 类型声明就默认其运行时可信。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("tool input must be a JSON object");
  }
  return value as JsonObject;
}

/**
 * 从 Pi 原生工具结果中提取适合审计和 UI 展示的短摘要。
 *
 * 回执只保存稳定的文本摘要，不把 Pi 私有 result 结构泄漏到 Semi-OS 协议层。
 */
function resultSummary(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return String(result);
  }
  const content = "content" in result ? result.content : undefined;
  if (!Array.isArray(content)) {
    return "Pi native tool completed";
  }
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Pi native tool completed";
}

function nativeToolRisk(toolName: string): ToolRiskLevel {
  if (toolName === "read") {
    return "read";
  }
  if (toolName === "edit" || toolName === "write") {
    return "local_write";
  }
  // bash 可以读写本地文件、启动进程或访问网络；在出现可靠命令分类器之前，
  // 必须按 privileged 保守处理，不能仅凭工具名把它误判为自动执行。
  return "privileged";
}

/**
 * 将 Pi 文件工具的工作区相对路径解析为绝对路径。
 *
 * 验证必须针对工具实际操作的文件，而不能依赖 Worker 进程当前目录；否则在
 * 多项目会话或测试环境中可能验证到错误文件。
 */
function nativeToolPath(cwd: string, input: JsonObject): string | undefined {
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * 独立验证 Pi 原生工具的执行后置条件。
 *
 * - read 没有持久化副作用，Pi 返回非错误结果即可视为本次读取成功；
 * - write/edit 必须重新读取磁盘并与调用前计算出的目标内容精确比较；
 * - bash 能产生任意副作用，目前没有通用且可靠的后置条件，因此只能
 *   返回 inconclusive，不能仅凭 Pi 声称执行完成就标记成功。
 *
 * 这里刻意不解析模型文本来判断成功，产品状态只能由结构化执行证据推进。
 */
async function verifyNativeTool(
  cwd: string,
  toolName: string,
  input: JsonObject,
  toolCallId: string,
  expectedFileContent?: string,
): Promise<VerificationRecord> {
  if (toolName === "read") {
    return {
      status: "passed",
      method: "pi_native_read_result",
      summary: "Pi returned readable content without an execution error",
      evidence: [{ kind: "pi_tool_result", reference: toolCallId }],
    };
  }

  if (toolName === "write" || toolName === "edit") {
    const path = nativeToolPath(cwd, input);
    if (!path || expectedFileContent === undefined) {
      return {
        status: "inconclusive",
        method: "filesystem_exact_postcondition",
        summary: `${toolName} did not have a deterministic file postcondition`,
        evidence: [],
      };
    }
    try {
      const actual = await readFile(path, "utf8");
      return {
        status: actual === expectedFileContent ? "passed" : "failed",
        method: "filesystem_exact_postcondition",
        summary:
          actual === expectedFileContent
            ? `${toolName} result exactly matches the computed postcondition`
            : `${toolName} result does not match the computed postcondition`,
        evidence: [{ kind: "local_file", reference: path }],
      };
    } catch (error) {
      return {
        status: "inconclusive",
        method: "filesystem_exact_postcondition",
        summary: `Unable to inspect ${toolName} result: ${String(error)}`,
        evidence: [{ kind: "local_file", reference: path }],
      };
    }
  }

  return {
    status: "inconclusive",
    method: "pi_native_unverified",
    summary: "Native tool completed but has no independent postcondition verifier",
    evidence: [{ kind: "pi_tool_result", reference: toolCallId }],
  };
}

/**
 * 在文件修改发生前计算确定性的目标内容，供执行结束后的独立验证使用。
 *
 * edit 只有在每个 oldText 唯一命中且编辑区间互不重叠时才可推导目标内容。
 * 任何歧义都会返回 undefined，后续回执进入 unknown，而不是进行猜测性验证。
 */
async function expectedNativeFileContent(
  cwd: string,
  toolName: string,
  input: JsonObject,
): Promise<string | undefined> {
  if (toolName === "write") {
    return typeof input.content === "string" ? input.content : undefined;
  }
  if (toolName !== "edit") {
    return undefined;
  }
  const path = nativeToolPath(cwd, input);
  if (!path || !Array.isArray(input.edits) || input.edits.length === 0) {
    return undefined;
  }
  try {
    const original = await readFile(path, "utf8");
    const replacements: Array<{
      start: number;
      end: number;
      newText: string;
    }> = [];
    for (const edit of input.edits) {
      if (typeof edit !== "object" || edit === null) {
        return undefined;
      }
      const oldText = "oldText" in edit ? edit.oldText : undefined;
      const newText = "newText" in edit ? edit.newText : undefined;
      if (
        typeof oldText !== "string" ||
        oldText.length === 0 ||
        typeof newText !== "string"
      ) {
        return undefined;
      }
      const start = original.indexOf(oldText);
      if (start < 0 || original.indexOf(oldText, start + 1) >= 0) {
        return undefined;
      }
      replacements.push({ start, end: start + oldText.length, newText });
    }
    replacements.sort((left, right) => right.start - left.start);
    for (let index = 1; index < replacements.length; index += 1) {
      if (replacements[index - 1]!.start < replacements[index]!.end) {
        return undefined;
      }
    }
    return replacements.reduce(
      (content, replacement) =>
        `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`,
      original,
    );
  } catch {
    return undefined;
  }
}

/**
 * 校验并提取 checkpoint 中的 Pi 持久化会话文件。
 *
 * Semi-OS 的 sequence 只能恢复工具尝试编号，无法恢复模型上下文；真正续接
 * 对话必须让 Pi 打开原 JSONL Session。缺少该文件的 checkpoint 不具备恢复
 * 能力，因此必须在启动阶段明确拒绝。
 */
function checkpointSessionFile(checkpoint?: AgentCheckpoint): string | undefined {
  if (!checkpoint) {
    return undefined;
  }
  if (checkpoint.data.runtime !== "pi") {
    throw new AgentRuntimeStateError("checkpoint does not belong to Pi runtime");
  }
  const sessionFile = checkpoint.data.runtimeSessionFile;
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new AgentRuntimeStateError(
      "Pi checkpoint is missing a persisted runtime session file",
    );
  }
  return sessionFile;
}

/**
 * Pi SDK 的唯一产品适配器。
 *
 * Semi-OS 工具在这里转换为 Pi ToolDefinition，但执行后仍使用产品自己的
 * verify/receipt 语义。Pi 的事件、Session 类型和工具 schema 不得越过本文件，
 * 以便后续升级 Pi 或替换 Runtime 时保持任务模型稳定。
 */
export class PiAgentRuntime extends EventedAgentRuntime {
  // 以下依赖均保持为适配器私有成员，Pi 类型不会进入产品 Runtime 接口。
  readonly #now: () => number;
  readonly #createSession: typeof createAgentSession;
  readonly #baseToolNames: readonly string[];
  readonly #sessionDir?: string;
  readonly #createSessionManager: (
    input: CreatePiSessionManagerInput,
  ) => SessionManager;
  readonly #createResourceLoader: (
    input: CreatePiResourceLoaderInput,
  ) => ResourceLoader;
  readonly #resolvePolicyDecision: NonNullable<
    PiAgentRuntimeOptions["resolvePolicyDecision"]
  >;
  #session?: AgentSession;
  #sessionManager?: SessionManager;
  #unsubscribe?: () => void;
  #productSessionId?: string;
  #taskId?: string;
  #cwd?: string;
  // sequence 是产品级工具尝试序号；成功、失败、拦截和 unknown 都必须占号。
  #sequence = 0;
  // Pi 只允许在 Session 创建时注册工具，运行中只能切换已注册工具的活跃状态。
  #registeredToolNames = new Set<string>();
  /**
   * Pi 原生工具由 SDK 自己执行，不能复用自定义工具的 execute 包装器。
   * 因此在 tool_call 前置钩子记录尝试上下文，在 tool_execution_end 后置钩子
   * 完成验证和回执，两端以 Pi 的 toolCallId 关联。
   */
  #nativeAttempts = new Map<
    string,
    {
      identity: ToolAttemptIdentity;
      toolName: string;
      input: JsonObject;
      policyDecision: PolicyDecision;
      riskLevel: ToolRiskLevel;
      startedAtMs: number;
      expectedFileContent?: string;
    }
  >();

  constructor(options: PiAgentRuntimeOptions = {}) {
    super();
    this.#now = options.now ?? Date.now;
    this.#createSession = options.createSession ?? createAgentSession;
    this.#baseToolNames = options.baseToolNames ?? [
      "read",
      "bash",
      "edit",
      "write",
    ];
    this.#sessionDir = options.sessionDir;
    this.#createSessionManager =
      options.createSessionManager ??
      ((input) => {
        const sessionFile = checkpointSessionFile(input.checkpoint);
        // 有 checkpoint 时必须打开原会话；新建 Session 会丢失中断前上下文。
        return sessionFile
          ? SessionManager.open(sessionFile, this.#sessionDir, input.cwd)
          : SessionManager.create(input.cwd, this.#sessionDir);
      });
    this.#createResourceLoader =
      options.createResourceLoader ??
      ((input) =>
        new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: getAgentDir(),
          // 使用 Pi 官方扩展入口治理原生工具，避免复制 read/bash/edit/write。
          extensionFactories: [input.extension],
        }));
    this.#resolvePolicyDecision =
      options.resolvePolicyDecision ??
      (async (tool) =>
        tool.riskLevel === "read" || tool.riskLevel === "local_write"
          ? "auto"
          : "confirmation_required");
  }

  async startSession(input: StartSessionInput): Promise<AgentSessionHandle> {
    if (this.#session) {
      throw new AgentRuntimeStateError("runtime session has already started");
    }
    if (
      input.checkpoint &&
      input.checkpoint.sessionId !== input.sessionId
    ) {
      throw new AgentRuntimeStateError(
        "checkpoint product session does not match requested session",
      );
    }
    // 恢复必须消费精确的 Pi JSONL Session，而不是只恢复 Semi-OS 的序号。
    // 提前校验可避免依赖注入或未来重构绕过默认 SessionManager 的检查。
    checkpointSessionFile(input.checkpoint);
    const customTools = input.tools.map((tool) => this.#toPiTool(tool));
    const sessionManager = this.#createSessionManager({
      cwd: input.cwd,
      checkpoint: input.checkpoint,
    });
    const resourceLoader = this.#createResourceLoader({
      cwd: input.cwd,
      extension: this.#nativeToolExtension(),
    });
    const { session } = await this.#createSession({
      cwd: input.cwd,
      customTools,
      // tools 决定 Session 初始可见集合；自定义工具仍需先通过 customTools 注册。
      tools: [
        ...this.#baseToolNames,
        ...input.tools.map((tool) => tool.name),
      ],
      resourceLoader,
      sessionManager,
    });
    this.#session = session;
    this.#sessionManager = sessionManager;
    this.#productSessionId = input.sessionId;
    this.#cwd = input.cwd;
    this.#sequence = input.checkpoint?.sequence ?? 0;
    this.#registeredToolNames = new Set(input.tools.map((tool) => tool.name));
    // 只向上转换产品关心的事件，调用方不依赖 Pi 的完整事件联合类型。
    this.#unsubscribe = session.subscribe((event) => this.#onPiEvent(event));
    this.publish({ kind: "session.started", sessionId: input.sessionId });
    return {
      sessionId: input.sessionId,
      runtimeSessionRef: session.sessionId,
    };
  }

  async prompt(input: AgentPrompt): Promise<void> {
    const session = this.#requireSession();
    // Pi 工具事件本身不携带 Semi-OS TaskRun ID，调用前需保存当前任务归属。
    this.#taskId = input.taskId;
    try {
      await session.prompt(input.text);
    } catch (error) {
      this.publish({
        kind: "runtime.error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async steer(input: AgentSteering): Promise<void> {
    // steer 是对当前执行中的插话，仍应把后续工具尝试归属到这次 TaskRun。
    this.#taskId = input.taskId;
    await this.#requireSession().steer(input.text);
  }

  async followUp(input: AgentFollowUp): Promise<void> {
    // follow-up 开启同一 Session 中的后续轮次，但不创建隐藏的第二条 Agent Loop。
    this.#taskId = input.taskId;
    await this.#requireSession().followUp(input.text);
  }

  async pause(_taskId: string): Promise<PauseResult> {
    const session = this.#requireSession();
    const interrupted = session.isStreaming;
    if (interrupted) {
      // 先停止流式生成再取 checkpoint，避免保存点与仍在追加的 Session 不一致。
      await session.abort();
    }
    return { checkpoint: await this.checkpoint(), interrupted };
  }

  async abort(_taskId: string): Promise<void> {
    await this.#requireSession().abort();
  }

  async replaceTools(tools: readonly ToolDefinition[]): Promise<void> {
    const session = this.#requireSession();
    const unknown = tools
      .map((tool) => tool.name)
      .filter((name) => !this.#registeredToolNames.has(name));
    if (unknown.length > 0) {
      // Pi 不支持在现有 Session 中凭名称注册全新工具，静默忽略会导致能力漂移。
      throw new AgentRuntimeStateError(
        `tools were not registered when the Pi session started: ${unknown.join(", ")}`,
      );
    }
    // 动态注入只管理 Semi-OS 自定义工具；Pi 原生文件/终端工具属于 Runtime
    // 基线能力，不能因一次 Skill 或权限刷新被意外清空。
    session.setActiveToolsByName([
      ...this.#baseToolNames,
      ...tools.map((tool) => tool.name),
    ]);
  }

  async checkpoint(): Promise<AgentCheckpoint> {
    const session = this.#requireSession();
    if (!this.#productSessionId) {
      throw new AgentRuntimeStateError("product session id is unavailable");
    }
    const runtimeSessionFile = this.#sessionManager?.getSessionFile();
    if (!runtimeSessionFile) {
      throw new AgentRuntimeStateError(
        "Pi session is not persisted and cannot produce a recoverable checkpoint",
      );
    }
    return {
      sessionId: this.#productSessionId,
      sequence: this.#sequence,
      data: {
        // runtimeSessionFile 是恢复所需的关键字段，其余字段主要用于诊断和展示。
        runtime: "pi",
        runtimeSessionId: session.sessionId,
        runtimeSessionFile,
        messageCount: session.messages.length,
        activeTools: session.getActiveToolNames(),
      },
    };
  }

  async dispose(): Promise<void> {
    // 解除订阅后再销毁 Session，防止清理阶段的 Pi 事件继续进入产品事件流。
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#session?.dispose();
    this.#session = undefined;
    this.#sessionManager = undefined;
    this.#cwd = undefined;
    this.#nativeAttempts.clear();
    this.#registeredToolNames.clear();
  }

  #requireSession(): AgentSession {
    if (!this.#session) {
      throw new AgentRuntimeStateError("runtime session has not started");
    }
    return this.#session;
  }

  #toPiTool(tool: ToolDefinition): PiToolDefinition {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Pi 使用 TypeBox 做参数校验；产品层保存标准 JSON Schema，边界处只做
      // 一次显式适配，避免 Tool SDK 反向依赖 Pi 的 schema 库。
      parameters: Type.Unsafe<JsonObject>(tool.inputSchema),
      execute: async (toolCallId, rawInput, signal) => {
        const input = asJsonObject(rawInput);
        const taskId = this.#taskId;
        if (!taskId) {
          throw new AgentRuntimeStateError("tool executed without an active task");
        }
        const policyDecision = await this.#resolvePolicyDecision(
          tool,
          input,
          taskId,
        );
        // 在执行前分配 attempt，确保策略拒绝或 execute 抛错同样拥有终态回执。
        const identity = this.#allocateAttempt(taskId, toolCallId);
        try {
          // 自定义工具统一走产品执行器，由它负责策略、执行、验证和异常分类。
          const executed = await executeProductTool({
            tool,
            input,
            identity,
            signal: signal ?? new AbortController().signal,
            policyDecision,
            now: this.#now,
          });
          this.publish({ kind: "tool.completed", receipt: executed.receipt });
          return {
            // 返回给 Pi 的 content 只供 Agent 继续推理；details 中的 receipt
            // 是结构化证据，不能被模型文本替代。
            content: [
              { type: "text", text: executed.result.outputSummary },
            ],
            details: { receipt: executed.receipt },
          };
        } catch (error) {
          if (error instanceof ToolExecutionError) {
            // 先发布失败/unknown 回执，再将异常交还 Pi 结束本次工具调用。
            this.publish({ kind: "tool.completed", receipt: error.receipt });
          }
          throw error;
        }
      },
    };
  }

  #allocateAttempt(taskId: string, toolCallId: string): ToolAttemptIdentity {
    const attemptNumber = ++this.#sequence;
    return {
      taskId,
      attemptId: `attempt_pi_${attemptNumber}`,
      attemptNumber,
      // 同一 TaskRun 内以 Pi call ID 构造稳定幂等键，供 Host 去重和恢复对账。
      idempotencyKey: `${taskId}:${toolCallId}`,
    };
  }

  #nativeToolExtension(): InlineExtension {
    return {
      name: "semi-os-native-tool-policy",
      // 这是 Runtime 基础设施，不应作为用户可选择的普通 Pi 扩展显示。
      hidden: true,
      factory: (pi) => this.#registerNativeToolHooks(pi),
    };
  }

  #registerNativeToolHooks(pi: ExtensionAPI): void {
    /**
     * 前置钩子发生在 Pi 真正执行原生工具之前。
     *
     * 此处完成风险分类、策略判定、尝试编号及可验证后置条件快照。策略未授权时
     * 直接阻断，因此 Pi 原生工具不会绕过 Semi-OS 的确认和审计边界。
     */
    pi.on("tool_call", async (event) => {
      if (!this.#baseToolNames.includes(event.toolName)) {
        return;
      }
      const taskId = this.#taskId;
      if (!taskId) {
        return {
          block: true,
          terminate: true,
          reason: "Semi-OS native tool call has no active task",
        };
      }
      const input = asJsonObject(event.input);
      const riskLevel = nativeToolRisk(event.toolName);
      const subject: ToolPolicySubject = {
        name: event.toolName,
        description: `Pi native ${event.toolName} tool`,
        riskLevel,
      };
      const policyDecision = await this.#resolvePolicyDecision(
        subject,
        input,
        taskId,
      );
      const identity = this.#allocateAttempt(taskId, event.toolCallId);
      const startedAtMs = this.#now();
      const expectedFileContent = await expectedNativeFileContent(
        this.#cwd ?? process.cwd(),
        event.toolName,
        input,
      );
      this.#nativeAttempts.set(event.toolCallId, {
        identity,
        toolName: event.toolName,
        input,
        policyDecision,
        riskLevel,
        startedAtMs,
        expectedFileContent,
      });
      if (policyDecision === "auto" || policyDecision === "approved") {
        // 返回 undefined 表示放行，由 Pi 继续执行其官方原生工具实现。
        return;
      }

      const needsUser = policyDecision === "confirmation_required";
      const message = `tool execution is not authorized: ${event.toolName} (${policyDecision})`;
      this.publish({
        kind: "tool.completed",
        receipt: this.#nativeReceipt(event.toolCallId, {
          status: needsUser ? "needs_user" : "failed",
          resultType: needsUser ? "needs_user" : "failure",
          outputSummary: message,
          verification: {
            status: "not_run",
            method: "semi_os_policy",
            summary: message,
            evidence: [],
          },
        }),
      });
      this.#nativeAttempts.delete(event.toolCallId);
      // confirmation_required 终止当前 Agent 循环，等待产品层确认后再继续；
      // 普通 deny 只阻断该工具调用，由 Pi 根据错误决定后续推理。
      return { block: true, terminate: needsUser, reason: message };
    });

    /**
     * 后置钩子把 Pi 原生工具结果转换成产品回执。
     *
     * 写操作即使由 Pi 报错，也可能已经部分生效，所以不能归类为确定失败；
     * 除非独立后置条件验证通过，否则写操作和 bash 均进入 unknown。
     */
    pi.on("tool_execution_end", async (event) => {
      if (!this.#nativeAttempts.has(event.toolCallId)) {
        return;
      }
      const attempt = this.#nativeAttempts.get(event.toolCallId)!;
      // read 无持久副作用，执行错误可确定为 failed；其余工具需要按不确定结果处理。
      const uncertain = attempt.riskLevel !== "read";
      const verification = event.isError
        ? {
            status: uncertain ? "inconclusive" : "failed",
            method: "pi_native_result",
            summary: "Pi native tool reported an execution error",
            evidence: [
              { kind: "pi_tool_result", reference: event.toolCallId },
            ],
          } satisfies VerificationRecord
        : await verifyNativeTool(
            this.#cwd ?? process.cwd(),
            event.toolName,
            attempt.input,
            event.toolCallId,
            attempt.expectedFileContent,
          );
      const succeeded = verification.status === "passed";
      this.publish({
        kind: "tool.completed",
        receipt: this.#nativeReceipt(event.toolCallId, {
          status: succeeded ? "succeeded" : uncertain ? "unknown" : "failed",
          resultType: succeeded ? "success" : uncertain ? "unknown" : "failure",
          outputSummary: resultSummary(event.result),
          verification,
        }),
      });
      this.#nativeAttempts.delete(event.toolCallId);
    });
  }

  /**
   * 根据前置钩子保存的上下文创建统一 ToolExecutionReceipt。
   *
   * 该方法不自行判断成功与否；调用方必须先根据执行结果和独立验证给出终态，
   * 从而避免“工具返回了文本”被误当成“任务已经成功”。
   */
  #nativeReceipt(
    toolCallId: string,
    fields: Pick<
      ToolExecutionReceipt,
      "status" | "resultType" | "outputSummary" | "verification"
    >,
  ): ToolExecutionReceipt {
    const attempt = this.#nativeAttempts.get(toolCallId);
    if (!attempt) {
      throw new AgentRuntimeStateError(
        `native tool attempt is unavailable: ${toolCallId}`,
      );
    }
    const finishedAtMs = this.#now();
    return {
      ...attempt.identity,
      toolName: attempt.toolName,
      status: fields.status,
      riskLevel: attempt.riskLevel,
      inputSummary: `input for Pi native ${attempt.toolName}`,
      inputDigest: digestToolInput(attempt.input),
      policyDecision: attempt.policyDecision,
      startedAtMs: attempt.startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - attempt.startedAtMs,
      resultType: fields.resultType,
      outputSummary: fields.outputSummary,
      verification: fields.verification,
      artifacts: [],
    };
  }

  #onPiEvent(event: AgentSessionEvent): void {
    // 文本增量只负责响应展示和后续 TTS，不参与任务成功判定。
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        this.publish({ kind: "assistant.text_delta", text: update.delta });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      // requested 表示工具已进入执行流程；最终状态由对应 completed 回执给出。
      this.publish({
        kind: "tool.requested",
        callId: event.toolCallId,
        toolName: event.toolName,
        input: asJsonObject(event.args),
      });
      return;
    }
    if (event.type === "agent_end" && this.#taskId) {
      // turn.completed 只表示 Pi 本轮结束，不代表所有工具均已验证成功。
      this.publish({ kind: "turn.completed", taskId: this.#taskId });
    }
  }
}
