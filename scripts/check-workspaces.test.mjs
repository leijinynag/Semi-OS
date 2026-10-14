import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredScripts, validateWorkspaceScripts } from "./check-workspaces.mjs";

test("reports every missing workspace command with its package name", () => {
  assert.deepEqual(
    validateWorkspaceScripts([{ name: "missing", scripts: { build: " " } }]),
    requiredScripts.map((command) => `missing: missing required script "${command}"`),
  );
});

test("valid manifests pass; absent workspaces fail rather than silently skipping checks", () => {
  assert.deepEqual(
    validateWorkspaceScripts([
      {
        name: "complete",
        scripts: Object.fromEntries(requiredScripts.map((command) => [command, "node check.mjs"])),
      },
    ]),
    [],
  );
  assert.equal(validateWorkspaceScripts([]).length, 1);
});
