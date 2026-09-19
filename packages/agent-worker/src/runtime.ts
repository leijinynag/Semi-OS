import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionReceipt,
} from "@semi-os/tool-sdk";

export interface StartSessionInput {
  sessionId: string;
  taskId?: string;
  cwd: string;
  tools: readonly ToolDefinition[];
  checkpoint?: AgentCheckpoint;
}

export interface AgentSessionHandle {
  sessionId: string;
  runtimeSessionRef?: string;
}

export interface AgentPrompt {
  taskId: string;
  text: string;
}
// 引导类提示，用于初始化会话或设置上下文
export interface AgentSteering extends AgentPrompt {}

export interface AgentFollowUp extends AgentPrompt {}

export interface PauseResult {
  checkpoint: AgentCheckpoint;
  interrupted: boolean;
}

export interface AgentCheckpoint {
  sessionId: string;
  // 切片序列号，用于标识 checkpoint 的顺序，从 0 开始递增
  sequence: number;
  // checkpoint 的数据，用于恢复会话状态
  data: JsonObject;
}

export type AgentRuntimeEvent =
  | { kind: "session.started"; sessionId: string }
  | { kind: "assistant.text_delta"; text: string }
  | {
      kind: "tool.requested";
      callId: string;
      toolName: string;
      input: JsonObject;
    }
  | { kind: "tool.completed"; receipt: ToolExecutionReceipt }
  | { kind: "turn.completed"; taskId: string }
  | { kind: "runtime.error"; message: string };

export type RuntimeEventListener = (event: AgentRuntimeEvent) => void;
export type Unsubscribe = () => void;

/**
 * Agent Runtime 的产品级边界。
 *
 * Pi 的具体 Session、事件和工具对象只允许在适配器内部出现。业务编排和测试
 * 依赖本接口，未来升级 Pi 或接入另一 Runtime 时不改任务模型。
 */
export interface AgentRuntimeAdapter {
  startSession(input: StartSessionInput): Promise<AgentSessionHandle>;
  prompt(input: AgentPrompt): Promise<void>;
  steer(input: AgentSteering): Promise<void>;
  followUp(input: AgentFollowUp): Promise<void>;
  pause(taskId: string): Promise<PauseResult>;
  abort(taskId: string): Promise<void>;
  replaceTools(tools: readonly ToolDefinition[]): Promise<void>;
  subscribe(listener: RuntimeEventListener): Unsubscribe;
  checkpoint(): Promise<AgentCheckpoint>;
  dispose(): Promise<void>;
}

export class AgentRuntimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeStateError";
  }
}

export abstract class EventedAgentRuntime implements AgentRuntimeAdapter {
  readonly #listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  protected publish(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  abstract startSession(input: StartSessionInput): Promise<AgentSessionHandle>;
  abstract prompt(input: AgentPrompt): Promise<void>;
  abstract steer(input: AgentSteering): Promise<void>;
  abstract followUp(input: AgentFollowUp): Promise<void>;
  abstract pause(taskId: string): Promise<PauseResult>;
  abstract abort(taskId: string): Promise<void>;
  abstract replaceTools(tools: readonly ToolDefinition[]): Promise<void>;
  abstract checkpoint(): Promise<AgentCheckpoint>;
  abstract dispose(): Promise<void>;
}
