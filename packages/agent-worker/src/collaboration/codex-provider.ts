import { StructuredProvider, record, type ProviderStart } from "./provider.ts";

/** app-server 管理线程，操作仍受沙箱约束；无法识别的服务器请求一律拒绝。 */
export class CodexCodingProvider extends StructuredProvider {
  readonly capabilities = { steer: true, pause: false, resume: true };
  #thread = "";
  #turn = "";
  #sequence = 0;
  #requests = new Map<string, string>();
  start(input: ProviderStart): void {
    this.launch("codex", ["app-server", "--stdio"], input);
    this.#request("initialize", {
      clientInfo: { name: "semi-os", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
  }
  #request(method: string, params: unknown): void {
    const id = `semi_${++this.#sequence}`;
    this.#requests.set(id, method);
    this.process!.write({ id, method, params });
  }
  receive(message: Record<string, unknown>): void {
    if (typeof message.id === "string" && this.#requests.has(message.id)) {
      const method = this.#requests.get(message.id);
      this.#requests.delete(message.id);
      if (message.error) {
        this.fail("Codex app-server 拒绝请求");
        return;
      }
      const result = record(message.result);
      if (method === "initialize") {
        this.process!.write({ method: "initialized" });
        this.#request(this.input!.sessionId ? "thread/resume" : "thread/start", {
          ...(this.input!.sessionId ? { threadId: this.input!.sessionId } : {}),
          cwd: this.input!.cwd,
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          // workspace-write 会自动放行部分写操作；只读沙箱使变更必须升级到 Host 批准。
          sandbox: "read-only",
          config: { "features.multi_agent": false, "features.shell_tool": true },
          developerInstructions:
            "Work only on the assigned item. Do not spawn collaborators or commit/push. Return evidence, not internal reasoning.",
        });
      } else if (method === "thread/start" || method === "thread/resume") {
        const thread = record(result.thread);
        if (typeof thread.id !== "string") throw new Error("missing Codex thread");
        this.#thread = thread.id;
        this.input!.emit({ kind: "session", sessionId: thread.id });
        this.#request("turn/start", {
          threadId: this.#thread,
          input: [{ type: "text", text: this.input!.prompt }],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
      } else if (method === "turn/start") {
        const turn = record(result.turn);
        if (typeof turn.id === "string") this.#turn = turn.id;
      }
      return;
    }
    const method = message.method;
    const params = record(message.params);
    if (message.id !== undefined && typeof method === "string") {
      const id = message.id;
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        if (params.threadId !== this.#thread || !this.#turn || params.turnId !== this.#turn) {
          this.process!.write({ id, result: { decision: "decline" } });
          return;
        }
        void this.permission(
          {
            requestId: String(id),
            tool: method.includes("commandExecution") ? "bash" : "file_change",
            input: params,
          },
          (allowed) =>
            this.process!.write({ id, result: { decision: allowed ? "accept" : "decline" } }),
        );
      } else
        this.process!.write({
          id,
          error: { code: -32601, message: "Semi-OS does not authorize this request" },
        });
      return;
    }
    if (params.threadId && params.threadId !== this.#thread) return;
    if (params.turnId && params.turnId !== this.#turn) return;
    if (method === "turn/started") this.#turn = String(record(params.turn).id ?? "");
    else if (method === "item/agentMessage/delta") this.append(params.delta);
    else if (method === "item/started") {
      const item = record(params.item);
      if (["commandExecution", "fileChange"].includes(String(item.type)))
        this.input?.emit({ kind: "activity", tool: String(item.type) });
    } else if (method === "turn/completed") {
      const turn = record(params.turn);
      if (turn.id !== this.#turn) return;
      if (turn.status === "completed") this.complete(this.text);
      else this.fail("Codex 轮次失败或中断");
    } else if (method === "error" && params.willRetry !== true)
      this.fail("Codex 服务错误，请检查认证与配置");
  }
  steer(text: string): void {
    if (!this.#thread || !this.#turn || this.terminal || this.stopping)
      throw new Error("Codex has no active turn");
    this.#request("turn/steer", {
      threadId: this.#thread,
      expectedTurnId: this.#turn,
      input: [{ type: "text", text }],
    });
  }
  async pause(): Promise<void> {
    throw new Error("Codex turn/interrupt 是中断而非可恢复原地暂停");
  }
  override async stop(): Promise<void> {
    try {
      if (this.#thread && this.#turn)
        this.#request("turn/interrupt", { threadId: this.#thread, turnId: this.#turn });
    } finally {
      await super.stop();
    }
  }
}
