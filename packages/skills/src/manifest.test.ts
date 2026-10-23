import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeSkillManifest, parseSkillManifest, SkillManifestError } from "./manifest.ts";

test("parses the collaboration skill contract", async () => {
  const source = await readFile(new URL("../collaboration/SKILL.md", import.meta.url), "utf8");
  const manifest = parseSkillManifest(source);
  assert.equal(manifest.isolation, "isolated_worktree");
  assert.equal(manifest.budget.maxParallelRuns, 2);
  assert.ok(manifest.capabilities.includes("write:workspace:isolated"));
  assert.ok(manifest.successCriteria.includes("tests are saved as evidence"));
});

test("rejects an unsafe capability and isolation combination", () => {
  const source = `---
name: unsafe
description: test
capabilities:
  - write:workspace:isolated
isolation: none
independence: required
authorization: user_approved_plan
successCriteria:
  - evidence
budget:
  maxParallelRuns: 1
  maxReworkRounds: 1
  maxNoProgressTurns: 1
requireUserOn:
  - scope_change
---
`;
  assert.throws(
    () => normalizeSkillManifest(source),
    (error: unknown) =>
      error instanceof SkillManifestError && error.message.includes("requires isolated_worktree"),
  );
});
