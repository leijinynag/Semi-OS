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

test("normalizes legacy tools and exposes contract migration warnings", () => {
  const registry = new ToolRegistry();
  registry.register(
    tool({
      name: "legacy_write",
      riskLevel: "local_write",
      requiredCapabilities: [],
    }),
  );
  const [availability] = registry.evaluate({
    platform: "darwin",
    capabilities: new Map(),
    workspaceAvailable: true,
    runtimeHealthy: true,
  });
  assert.equal(availability?.active, true);
  assert.deepEqual(availability?.warnings, [
    "contract_observation_undeclared",
    "contract_verification_undeclared",
    "contract_reconciliation_unsupported",
  ]);
});

test("preserves explicitly declared execution semantics", () => {
  const registry = new ToolRegistry();
  const registered = tool({
    contract: {
      observation: { required: true, freshness: "fresh" },
      mutation: { kind: "workspace", atomic: true },
      verification: { required: true, method: "artifact" },
      reversibility: "partially_reversible",
      idempotency: "keyed",
      reconciliation: "required",
    },
    reconcile: async () => ({
      status: "succeeded",
      summary: "reconciled",
      verification: passedVerification,
    }),
  });
  registry.register(registered);
  const [availability] = registry.evaluate({
    platform: "darwin",
    capabilities: new Map(),
    workspaceAvailable: true,
    runtimeHealthy: true,
  });
  assert.deepEqual(availability?.warnings, []);
});
