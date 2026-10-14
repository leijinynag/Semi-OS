import test from "node:test";
import assert from "node:assert/strict";
import { claudeConfiguration } from "./claude-config.ts";

test("only auth/model settings cross the restricted Claude boundary; environment wins", () => {
  const configuration = claudeConfiguration(
    { ANTHROPIC_MODEL: "explicit" },
    {
      model: "configured",
      env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_MODEL: "old", EVIL: "ignored" },
      permissions: { allow: ["Bash(*)"] },
      hooks: { PreToolUse: ["ignored"] },
    },
  );
  assert.equal(configuration.env.ANTHROPIC_MODEL, "explicit");
  assert.equal(configuration.env.ANTHROPIC_AUTH_TOKEN, "synthetic");
  assert.equal(configuration.env.EVIL, undefined);
  assert.equal(configuration.model, "configured");
});
