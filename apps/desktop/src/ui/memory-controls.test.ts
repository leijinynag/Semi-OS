import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClientMemoryPage,
  projectMemoryPanel,
  readMemoryError,
  validatePreferenceDraft,
  type ClientMemoryPage,
} from "./memory-controls.ts";

const page: ClientMemoryPage = {
  preferences: [
    {
      memoryId: "pref_1",
      key: "语气",
      value: "活泼",
      author: "user",
      mutability: "user_readonly",
      updatedAtMs: 10,
    },
    {
      memoryId: "pref_bad",
      key: "theme",
      value: "dark",
      author: "user",
      mutability: "agent_mutable",
      updatedAtMs: 11,
    },
  ],
  memories: [
    {
      memoryId: "mem_agent",
      layer: "L2",
      recordKind: "project_fact",
      summary: "仓库使用 pnpm",
      author: "agent",
      mutability: "agent_mutable",
      updatedAtMs: 12,
    },
    {
      memoryId: "rule_confirm",
      layer: "L1",
      recordKind: "safety_rule",
      summary: "外部副作用需要确认",
      author: "system",
      mutability: "system_readonly",
      updatedAtMs: 13,
    },
  ],
  persona: {
    personalityId: "persona_local",
    version: 1,
    author: "user",
    mutability: "user_readonly",
  },
};

test("memory page shows ownership and only edits consistent user preferences", () => {
  const view = projectMemoryPanel(parseClientMemoryPage(page));
  assert.equal(view.preferences[0]?.editable, true);
  assert.equal(view.preferences[0]?.authorLabel, "用户");
  assert.equal(view.preferences[0]?.mutabilityLabel, "用户可改，Agent 只读");
  assert.equal(view.preferences[0]?.ownership, "user / user_readonly");
  assert.equal(view.preferences[1]?.editable, false);
  assert.equal(view.memories[0]?.editable, false);
  assert.equal(view.memories[0]?.authorLabel, "Agent");
  assert.equal(view.memories[0]?.mutabilityLabel, "Agent 可改");
  assert.equal(view.memories[0]?.ownership, "agent / agent_mutable");
  assert.equal(view.memories[1]?.authorLabel, "系统");
  assert.equal(view.memories[1]?.mutabilityLabel, "系统只读");
  assert.equal(view.preferenceEmpty, null);
  assert.equal(view.memoryEmpty, null);
  assert.match(view.personaLine, /人格 persona_local · 版本 1 · 用户/);
  assert.equal(view.personaLine.includes("活泼"), false);
  assert.equal(view.personaLine.includes("pnpm"), false);
});

test("empty memory page keeps preference and persona separate", () => {
  const view = projectMemoryPanel(
    parseClientMemoryPage({ preferences: [], memories: [], persona: null }),
  );
  assert.equal(view.preferenceEmpty, "还没有自己的偏好。");
  assert.equal(view.memoryEmpty, "还没有可查看的记忆。");
  assert.equal(view.personaLine, "尚未配置人格。偏好不会写入人格。");
});

test("memory snapshots reject unknown ownership and duplicate rows", () => {
  assert.throws(() => parseClientMemoryPage({ preferences: [], memories: [], persona: {} }));
  assert.throws(() =>
    parseClientMemoryPage({
      ...page,
      memories: page.memories.map((row) => ({ ...row, author: "model" })),
    }),
  );
  assert.throws(() =>
    parseClientMemoryPage({
      ...page,
      memories: page.memories.map((row, index) =>
        index === 0 ? { ...row, memoryId: "pref_1" } : row,
      ),
    }),
  );
});

test("preference drafts are trimmed and bounded before they reach the host", () => {
  assert.deepEqual(validatePreferenceDraft("  语言  ", " zh-CN "), { key: "语言", value: "zh-CN" });
  for (const [key, value] of [
    ["", "zh-CN"],
    ["语言", " "],
    ["语\n言", "zh-CN"],
    ["语言", "a".repeat(2001)],
  ] as const) {
    assert.throws(() => validatePreferenceDraft(key, value));
  }
});

test("memory errors stay short and do not invent a success", () => {
  assert.equal(readMemoryError("偏好内容无效"), "偏好内容无效");
  assert.equal(readMemoryError(new Error("找不到这条记录")), "找不到这条记录");
  assert.equal(readMemoryError({ secret: "token" }), "记忆操作失败");
});
