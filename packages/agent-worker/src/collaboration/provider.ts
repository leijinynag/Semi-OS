import type { CodingProvider } from "@semi-os/protocol";
import type { ProcessOptions, ProcessPort } from "./process.ts";
import { PipeProcess, parseProcessObject } from "./process.ts";

export interface ProviderPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}
/** 实现问答与权限分离；答案必须回填结构化 input，不能模拟终端输入“同意”。 */
export interface ProviderDecision {
  requestId: string;
  kind: "clarification" | "plan";
  input: Record<string, unknown>;
}
export type ProviderEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "activity"; tool: string }
  | { kind: "completed"; summary: string }
  | { kind: "failed"; message: string };
export interface ProviderStart {
  cwd: string;
  prompt: string;
  writing: boolean;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  emit(event: ProviderEvent): void;
  permission(request: ProviderPermission): Promise<boolean>;
  decision?(request: ProviderDecision): Promise<Record<string, unknown> | null>;
}
export interface CodingProviderPort {
  readonly capabilities: { steer: boolean; pause: boolean; resume: boolean };
  start(input: ProviderStart): void;
  steer(text: string): void;
  pause(): Promise<void>;
  stop(): Promise<void>;
}
export type ProcessFactory = (options: ProcessOptions) => ProcessPort;
export type ProviderFactory = (provider: CodingProvider) => CodingProviderPort;

/** 协议进程生命周期共用，模型选择、消息结构和权限返回留在各自 Adapter。 */
export abstract class StructuredProvider implements CodingProviderPort {
  abstract readonly capabilities: CodingProviderPort["capabilities"];
  protected process?: ProcessPort;
  protected input?: ProviderStart;
  protected terminal = false;
  protected stopping = false;
  protected text = "";
  readonly factory: ProcessFactory;
  constructor(factory: ProcessFactory = (options) => new PipeProcess(options)) {
    this.factory = factory;
  }
  protected launch(command: string, args: string[], input: ProviderStart): void {
    this.input = input;
    this.process = this.factory({
      command,
      args,
      cwd: input.cwd,
      env: input.env,
      onLine: (line) => {
        try {
          this.receive(parseProcessObject(line));
        } catch {
          this.fail("Provider 协议无效，执行结果需要核对");
          void this.stop();
        }
      },
      onError: (error) => {
        // 仅识别进程层自己定义的固定错误，不能把任意异常消息带到持久化/UI。
        const message =
          error.message === "provider input closed"
            ? "Provider 输入管道已关闭，执行结果需要核对"
            : error.message === "process frame limit exceeded"
              ? "Provider 输出超过协议大小限制，执行结果需要核对"
              : "Provider 进程不可用，请检查本地 CLI 和认证";
        this.fail(message);
      },
      onExit: () => {
        if (!this.terminal && !this.stopping) this.fail("Provider 未交付结果就退出");
      },
    });
  }
  protected complete(summary: string): void {
    if (this.terminal || this.stopping) return;
    this.terminal = true;
    this.input?.emit({
      kind: "completed",
      summary: summary.slice(-32_000) || "执行结束，尚未验收",
    });
  }
  protected fail(message: string): void {
    if (this.terminal || this.stopping) return;
    this.terminal = true;
    this.input?.emit({ kind: "failed", message });
  }
  protected append(value: unknown): void {
    if (this.terminal || this.stopping || typeof value !== "string") return;
    this.text = (this.text + value).slice(-32_000);
    this.input?.emit({ kind: "text", text: value.slice(0, 8_000) });
  }
  protected async permission(
    request: ProviderPermission,
    respond: (allowed: boolean) => void,
  ): Promise<void> {
    let allowed = false;
    try {
      allowed = !this.stopping && !this.terminal && !!(await this.input?.permission(request));
    } catch {
      /* Host 未给出肯定授权时一律拒绝，不能按超时放行。 */
    }
    if (!this.stopping) {
      try {
        respond(allowed);
      } catch {
        this.fail("权限回执发送失败");
      }
    }
  }
  abstract start(input: ProviderStart): void;
  abstract receive(message: Record<string, unknown>): void;
  abstract steer(text: string): void;
  abstract pause(): Promise<void>;
  async stop(): Promise<void> {
    this.stopping = true;
    await this.process?.stop();
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
