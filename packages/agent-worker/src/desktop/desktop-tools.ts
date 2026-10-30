import type { ToolDefinition } from "@semi-os/tool-sdk";
import { DesktopHost, type DesktopAction } from "./desktop-host.ts";

const string = { type: "string", minLength: 1 };
const target = { version: string, reference: string };
const actions = [
  ["observe", {}, []],
  ["click", target, ["version", "reference"]],
  [
    "type",
    { ...target, text: { type: "string", maxLength: 4000 } },
    ["version", "reference", "text"],
  ],
  [
    "key",
    {
      ...target,
      key: {
        enum: [
          "return",
          "tab",
          "escape",
          "space",
          "left",
          "right",
          "up",
          "down",
          "backspace",
          "a",
          "c",
          "v",
          "s",
          "z",
        ],
      },
      modifiers: {
        type: "array",
        uniqueItems: true,
        maxItems: 4,
        items: { enum: ["command", "shift", "option", "control"] },
      },
    },
    ["version", "reference", "key", "modifiers"],
  ],
  [
    "scroll",
    {
      ...target,
      direction: { enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: 8 },
    },
    ["version", "reference", "direction", "amount"],
  ],
  ["focus_window", target, ["version", "reference"]],
  [
    "launch_app",
    {
      bundleId: { type: "string", pattern: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", maxLength: 200 },
    },
    ["bundleId"],
  ],
] as const;

/** 工具不推断成功、不操作 OS；Host 返回的验证才可使工具通过。 */
export function createDesktopTools(host: DesktopHost): ToolDefinition[] {
  return actions.map(([kind, properties, required]): ToolDefinition => ({
    name: `desktop_${kind}`,
    description:
      kind === "observe"
        ? "读取前台窗口的脱敏语义与版本化目标引用。无权限时返回 needs_user。"
        : kind === "type"
          ? "替换指定语义输入框完整内容，不提交、不使用剪贴板；需要新鲜引用。"
          : `执行一次受 Host 授权的 ${kind} 原子动作；不支持脚本/宏，unknown 不得重试。`,
    riskLevel: kind === "observe" ? "read" : "external_side_effect",
    requiredCapabilities: ["desktop"],
    supportedPlatforms: ["darwin"],
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    contract: {
      observation: { required: kind !== "observe" && kind !== "launch_app", freshness: "fresh" },
      mutation: { kind: kind === "observe" ? "none" : "external", atomic: true },
      verification: { required: true, method: "host" },
      reversibility: kind === "observe" ? "reversible" : "partially_reversible",
      idempotency: kind === "observe" ? "idempotent" : "non_idempotent",
      reconciliation: kind === "observe" ? "safe" : "required",
    },
    execute: async (input, context) => {
      const action = { ...input, kind } as DesktopAction;
      const result = await host.execute(action, JSON.stringify(input), context);
      return {
        output: { ...result },
        outputSummary: result.summary,
        ...(result.status === "needs_user" || result.status === "failure"
          ? { resultType: result.status }
          : {}),
      };
    },
    verify: async (_input, result) => ({
      status: ["observed", "verified"].includes(String(result.output.status))
        ? "passed"
        : "inconclusive",
      method: "host_desktop_readback",
      summary: String(result.output.evidence ?? result.output.summary),
      evidence: [],
    }),
  }));
}
