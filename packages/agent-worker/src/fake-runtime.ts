import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionReceipt,
} from "@semi-os/tool-sdk";
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
  executeProductTool,
  ToolExecutionError,
} from "./tool-execution.ts";

export interface FakeToolCall {
  toolName: string;
  input: JsonObject;
}

export interface FakeRuntimeOptions {
  script: readonly FakeToolCall[];
  now?: () => number;
}

/**
 * 确定性的 Agent Runtime Fixture。
 *
 * 它走与 Pi 相同的 Adapter 和动态工具入口，但不依赖模型、账号或网络；测试
 * 因而能验证 Prompt -> Tool -> Verification -> Receipt 的真实编排边界。
 */
export class FakeAgentRuntime extends EventedAgentRuntime {
  readonly #script: readonly FakeToolCall[];
  readonly #now: () => number;
  #tools = new Map<string, ToolDefinition>();
  #sessionId?: string;
  #sequence = 0;
  #aborted = false;

  constructor(options: FakeRuntimeOptions) {
    super();
    this.#script = options.script;
    this.#now = options.now ?? Date.now;
  }

  async startSession(input: StartSessionInput): Promise<AgentSessionHandle> {
    this.#sessionId = input.sessionId;
    this.#sequence = input.checkpoint?.sequence ?? 0;
    await this.replaceTools(input.tools);
    this.publish({ kind: "session.started", sessionId: input.sessionId });
    return { sessionId: input.sessionId, runtimeSessionRef: `fake:${input.sessionId}` };
  }

  async prompt(input: AgentPrompt): Promise<void> {
    if (!this.#sessionId) {
      throw new AgentRuntimeStateError("runtime session has not started");
    }
    this.#aborted = false;
    for (const call of this.#script) {
      if (this.#aborted) {
        return;
      }
      const tool = this.#tools.get(call.toolName);
      if (!tool) {
        throw new Error(`tool is not active: ${call.toolName}`);
      }
      const callId = `fake_call_${this.#sequence + 1}`;
      this.publish({
        kind: "tool.requested",
        callId,
        toolName: call.toolName,
        input: call.input,
      });
      try {
        const executed = await executeProductTool({
          tool,
          input: call.input,
          identity: {
            taskId: input.taskId,
            attemptId: `attempt_fake_${this.#sequence + 1}`,
            attemptNumber: this.#sequence + 1,
            idempotencyKey: `${input.taskId}:${callId}`,
          },
          signal: new AbortController().signal,
          policyDecision: "auto",
          now: this.#now,
          inputSummary: `fixture input for ${tool.name}`,
        });
        this.#sequence += 1;
        this.publish({ kind: "tool.completed", receipt: executed.receipt });
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          this.#sequence += 1;
          this.publish({ kind: "tool.completed", receipt: error.receipt });
        }
        throw error;
      }
    }
    this.publish({ kind: "turn.completed", taskId: input.taskId });
  }

  async steer(input: AgentSteering): Promise<void> {
    await this.prompt(input);
  }

  async followUp(input: AgentFollowUp): Promise<void> {
    await this.prompt(input);
  }

  async pause(_taskId: string): Promise<PauseResult> {
    this.#aborted = true;
    return { checkpoint: await this.checkpoint(), interrupted: true };
  }

  async abort(_taskId: string): Promise<void> {
    this.#aborted = true;
  }

  async replaceTools(tools: readonly ToolDefinition[]): Promise<void> {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async checkpoint(): Promise<AgentCheckpoint> {
    if (!this.#sessionId) {
      throw new AgentRuntimeStateError("runtime session has not started");
    }
    return {
      sessionId: this.#sessionId,
      sequence: this.#sequence,
      data: { runtime: "fake" },
    };
  }

  async dispose(): Promise<void> {
    this.#aborted = true;
    this.#tools.clear();
  }
}
