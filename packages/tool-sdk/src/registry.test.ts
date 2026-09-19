import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationRecord } from "@semi-os/shared";
import { ToolRegistry, type ToolDefinition } from "./index.ts";

const passedVerification: VerificationRecord = {
  status: "passed",
  method: "fixture",
  summary: "fixture verified",
  evidence: [{ kind: "fixture", reference: "fixture:1" }],
};

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "browser_open",
    description: "Open a page",
    riskLevel: "read",
    inputSchema: { type: "object" },
    requiredCapabilities: ["browser.playwright"],
    async execute() {
      return { output: {}, outputSummary: "opened" };
    },
    async verify() {
      return passedVerification;
    },
    ...overrides,
  };
}

test("activates only tools allowed by capability, platform and policy", () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  registry.register(
    tool({
      name: "desktop_click",
      riskLevel: "privileged",
      requiredCapabilities: ["permission.accessibility"],
      supportedPlatforms: ["darwin"],
    }),
  );

  const available = registry.activeTools({
    platform: "darwin",
    capabilities: new Map([
      [
        "browser.playwright",
        {
          key: "browser.playwright",
          status: "available",
          observedAtMs: 1,
        },
      ],
      [
        "permission.accessibility",
        {
          key: "permission.accessibility",
          status: "unavailable",
          observedAtMs: 1,
        },
      ],
    ]),
    allowedRiskLevels: new Set(["read", "privileged"]),
    workspaceAvailable: true,
    runtimeHealthy: true,
  });

  assert.deepEqual(
    available.map((entry) => entry.name),
    ["browser_open"],
  );
});

test("rejects duplicate tool names", () => {
  const registry = new ToolRegistry();
  registry.register(tool());
  assert.throws(() => registry.register(tool()), /already registered/);
});
