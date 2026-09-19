import assert from "node:assert/strict";
import test from "node:test";
import { discoverRuntimeCapabilities, runCapabilityProbes } from "./capabilities.ts";

test("discovers installed commands without executing them", async () => {
  const result = await discoverRuntimeCapabilities({
    platform: "darwin",
    now: () => 42,
    commandExists: async (command) =>
      command === "playwright" || command === "codex",
  });

  assert.equal(result.snapshots.get("platform.macos")?.status, "available");
  assert.equal(result.snapshots.get("browser.playwright")?.status, "available");
  assert.equal(result.snapshots.get("coding.codex")?.status, "available");
  assert.equal(result.snapshots.get("coding.claude")?.status, "unavailable");
  assert.equal(result.observedAtMs, 42);
});

test("isolates a failed custom probe as unknown", async () => {
  const result = await runCapabilityProbes([
    {
      key: "provider.llm",
      async observe() {
        throw new Error("provider timeout");
      },
    },
  ]);

  assert.equal(result.get("provider.llm")?.status, "unknown");
  assert.match(result.get("provider.llm")?.reason ?? "", /provider timeout/);
});
