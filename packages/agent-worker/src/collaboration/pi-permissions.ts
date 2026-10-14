import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 官方 tool_call 是所有原生工具的 preflight；未收到 Host 回执不能执行。 */
export default function permissions(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, context) => {
    const allowed = await context.ui.confirm(
      "semi-os-tool-policy",
      JSON.stringify({ tool: event.toolName, input: event.input }),
    );
    return allowed ? undefined : { block: true, reason: "Semi-OS Host denied this operation" };
  });
  pi.on("user_bash", () => ({
    operations: {
      exec: async () => {
        throw new Error("Interactive shell is not available to child agents");
      },
    },
  }));
}
