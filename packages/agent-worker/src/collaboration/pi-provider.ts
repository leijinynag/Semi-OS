import { fileURLToPath } from "node:url";
import { StructuredProvider, record, type ProviderStart } from "./provider.ts";
import { readCloudLlmConfig } from "../config/llm.ts";

export class PiCodingProvider extends StructuredProvider {
  readonly capabilities = { steer: true, pause: false, resume: true };
  start(input: ProviderStart): void {
    const model = readCloudLlmConfig(input.env ?? process.env);
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--provider",
      model.provider,
      "--model",
      model.model,
      "-e",
      fileURLToPath(new URL("./pi-permissions.ts", import.meta.url)),
      "--tools",
      input.writing ? "read,grep,find,ls,write,edit,bash" : "read,grep,find,ls",
    ];
    if (input.sessionId) args.push("--session", input.sessionId);
    this.launch("pi", args, input);
    this.process!.write({ type: "get_state", id: "session" });
    this.process!.write({ type: "prompt", message: input.prompt, id: "prompt" });
  }
  receive(message: Record<string, unknown>): void {
    if (message.type === "response") {
      if (message.success === false) this.fail("Pi 拒绝请求，请检查 CLI 配置");
      const data = record(message.data);
      if (message.id === "session" && typeof data.sessionFile === "string")
        this.input?.emit({ kind: "session", sessionId: data.sessionFile });
    } else if (message.type === "message_update") {
      const event = record(message.assistantMessageEvent);
      if (event.type === "text_delta") this.append(event.delta);
    } else if (message.type === "agent_end") {
      const messages = Array.isArray(message.messages) ? message.messages : [];
      const failed = ["error", "aborted"].includes(String(record(messages.at(-1)).stopReason));
      if (failed) this.fail("Pi 未正常完成任务");
      else this.complete(this.text);
    } else if (message.type === "tool_execution_start") {
      this.input?.emit({ kind: "activity", tool: String(message.toolName ?? "tool") });
    } else if (message.type === "extension_ui_request" && typeof message.id === "string") {
      const id = message.id;
      if (
        message.method === "confirm" &&
        message.title === "semi-os-tool-policy" &&
        typeof message.message === "string"
      ) {
        const request = record(JSON.parse(message.message));
        if (typeof request.tool !== "string") throw new Error("invalid permission request");
        void this.permission(
          { requestId: id, tool: request.tool, input: record(request.input) },
          (allowed) =>
            this.process!.write({ type: "extension_ui_response", id, confirmed: allowed }),
        );
      } else if (["confirm", "input", "editor", "select"].includes(String(message.method))) {
        this.process!.write({ type: "extension_ui_response", id, cancelled: true });
      }
    }
  }
  steer(text: string): void {
    if (this.terminal || this.stopping) throw new Error("Pi run is no longer active");
    this.process!.write({ type: "steer", message: text });
  }
  async pause(): Promise<void> {
    throw new Error("Pi RPC 不支持可核验的原地暂停；请取消后明确恢复");
  }
  override async stop(): Promise<void> {
    try {
      this.process?.write({ type: "clear_queue" });
      this.process?.write({ type: "abort" });
    } finally {
      await super.stop();
    }
  }
}
