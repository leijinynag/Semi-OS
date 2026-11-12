import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_COMMANDS,
  MEMORY_VOICE_NOTE,
  formatMemoryTime,
  parseClientMemoryPage,
  projectMemoryPanel,
  readMemoryError,
  validateCorrectionDraft,
  validatePreferenceDraft,
  type ClientMemoryItem,
  type ClientMemoryPage,
  type MemorySectionId,
} from "./memory-controls.ts";

const actions = {
  correct: true,
  disable: true,
  forget: true,
  viewSource: true,
  restore: false,
};

function item(
  partial: Partial<ClientMemoryItem> & Pick<ClientMemoryItem, "memoryId" | "section">,
): ClientMemoryItem {
  return {
    layer: "L2",
    recordKind: "project_fact",
    summary: partial.summary ?? partial.memoryId,
    preferenceKey: null,
    preferenceValue: null,
    sources: [
      {
        sourceId: `src_${partial.memoryId}`,
        kind: "task",
        sourceRef: "task_demo",
        note: "来自任务",
        createdAtMs: 4,
      },
    ],
    scopeLabel: "用户 local · 工作区 repo",
    author: "agent",
    mutability: "agent_mutable",
    updatedAtMs: 12,
    lastRecalledAtMs: 20,
    recallReason: "基础包",
    status: "active",
    hasConflict: false,
    actions,
    ...partial,
  };
}

function section(id: MemorySectionId, items: ClientMemoryItem[] = []) {
  return { id, items };
}

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
  sections: [
    section("user_settings", [
      item({
        memoryId: "pref_1",
        section: "user_settings",
        recordKind: "preference",
        summary: "语气：活泼",
        preferenceKey: "语气",
        preferenceValue: "活泼",
        author: "user",
        mutability: "user_readonly",
        scopeLabel: "用户 local",
        sources: [
          {
            sourceId: "src_pref_1",
            kind: "user_entry",
            sourceRef: "client-preference",
            note: null,
            createdAtMs: 10,
          },
        ],
        actions: { ...actions, correct: true },
      }),
    ]),
    section("agent_learned", [
      item({
        memoryId: "learned_font",
        section: "agent_learned",
        recordKind: "preference",
        summary: "font：sans",
        preferenceKey: "font",
        preferenceValue: "sans",
        recallReason: "上下文包",
      }),
    ]),
    section("project_application", [
      item({
        memoryId: "mem_agent",
        section: "project_application",
        summary: "仓库使用 pnpm",
        hasConflict: true,
        status: "conflict_inactive",
      }),
    ]),
    section("task_experience", [
      item({
        memoryId: "task_done",
        section: "task_experience",
        layer: "L3",
        recordKind: "verified_outcome",
        summary: "打开资料页已验证",
        recallReason: "搜索",
        lastRecalledAtMs: null,
      }),
    ]),
    section("unverified_workflow", [
      item({
        memoryId: "flow_1",
        section: "unverified_workflow",
        layer: "L5",
        recordKind: "workflow_candidate",
        summary: "发布：还没有验证",
        status: "disabled",
        actions: { ...actions, correct: true, disable: false, restore: true },
      }),
    ]),
  ],
  forgotten: [
    item({
      memoryId: "gone_1",
      section: "task_experience",
      layer: "L3",
      recordKind: "task_summary",
      summary: "误删的任务摘要",
      status: "forgotten",
      lastRecalledAtMs: null,
      recallReason: null,
      actions: { correct: false, disable: false, forget: false, viewSource: true, restore: true },
    }),
  ],
  activity: [
    {
      activityId: "act_1",
      memoryId: null,
      kind: "recalled",
      summary: "召回了 1 条：基础包",
      createdAtMs: 20,
    },
    {
      activityId: "act_2",
      memoryId: "mem_secret",
      kind: "write_failed",
      summary: "写入被拒绝：secret",
      createdAtMs: 21,
    },
  ],
  persona: {
    personalityId: "persona_local",
    version: 1,
    author: "user",
    mutability: "user_readonly",
  },
};

test("memory page distinguishes settings, learned items, experience and workflows", () => {
  const view = projectMemoryPanel(parseClientMemoryPage(page));
  assert.deepEqual(
    view.sections.map((section) => section.title),
    ["用户设置", "Agent 学到的", "项目与应用经验", "任务经验", "未验证工作流"],
  );
  assert.equal(view.sections[0]?.items[0]?.editablePreference, true);
  assert.equal(view.sections[0]?.items[0]?.authorLabel, "用户");
  assert.equal(view.sections[0]?.items[0]?.mutabilityLabel, "用户可改，Agent 只读");
  assert.equal(view.preferences[0]?.editable, true);
  assert.equal(view.preferences[0]?.metaLabel, "你可改 · Agent 只读");
  assert.equal(view.preferences[1]?.editable, false);
  const project = view.sections[2]?.items[0];
  assert.equal(project?.summary, "仓库使用 pnpm");
  assert.equal(project?.scopeLabel, "用户 local · 工作区 repo");
  assert.equal(project?.authorLabel, "Agent");
  assert.equal(project?.statusLabel, "冲突未生效");
  assert.equal(project?.conflictLabel, "有冲突");
  assert.equal(project?.recallReason, "基础包");
  assert.equal(project?.recalledLabel, "1970-01-01 08:00 Asia/Shanghai");
  assert.equal(project?.restoreHint, null);
  assert.deepEqual(project?.sourceLines, ["任务 task_demo · 来自任务"]);
  assert.equal(project?.actions.correct, true);
  assert.equal(project?.actions.disable, true);
  assert.equal(project?.actions.forget, true);
  assert.equal(project?.actions.viewSource, true);
  assert.equal(view.sections[3]?.items[0]?.recalledLabel, "尚未召回");
  assert.equal(view.sections[3]?.items[0]?.recallReason, "搜索");
  assert.equal(view.sections[4]?.items[0]?.statusLabel, "已停用");
  assert.equal(view.sections[4]?.items[0]?.restoreHint, null);
  assert.equal(view.sections[4]?.items[0]?.actions.restore, true);
  assert.equal(view.forgotten[0]?.statusLabel, "已忘记");
  assert.equal(view.forgotten[0]?.restoreHint, null);
  assert.equal(view.forgotten[0]?.actions.restore, true);
  assert.equal(view.forgotten[0]?.actions.correct, false);
  assert.equal(view.activity[0]?.label, "召回");
  assert.equal(view.activity[1]?.label, "写入失败");
  assert.equal(view.voiceNote, MEMORY_VOICE_NOTE);
  assert.equal(view.voiceNote.includes("语音播报"), true);
  assert.match(view.personaLine, /人格 persona_local · 版本 1 · 用户/);
  assert.equal(view.personaLine.includes("活泼"), false);
  assert.equal(view.personaLine.includes("pnpm"), false);
});

test("control actions map to host commands and user rows stay read-only to the agent", () => {
  assert.equal(MEMORY_COMMANDS.correct, "correct_client_memory");
  assert.equal(MEMORY_COMMANDS.disable, "disable_client_memory");
  assert.equal(MEMORY_COMMANDS.forget, "forget_client_memory");
  assert.equal(MEMORY_COMMANDS.restore, "restore_client_memory");
  const view = projectMemoryPanel(page);
  const userSetting = view.sections[0]?.items[0];
  assert.equal(userSetting?.editablePreference, true);
  assert.equal(userSetting?.mutabilityLabel, "用户可改，Agent 只读");
  assert.equal(view.sections[1]?.items[0]?.editablePreference, false);
  assert.equal(view.sections[1]?.items[0]?.actions.correct, true);
});

test("empty memory page keeps the five sections and persona separate", () => {
  const view = projectMemoryPanel(
    parseClientMemoryPage({
      preferences: [],
      sections: [
        section("user_settings"),
        section("agent_learned"),
        section("project_application"),
        section("task_experience"),
        section("unverified_workflow"),
      ],
      forgotten: [],
      activity: [],
      persona: null,
    }),
  );
  assert.equal(view.preferenceEmpty, "还没有偏好");
  assert.equal(
    view.sections.every((section) => section.empty),
    true,
  );
  assert.equal(view.activityEmpty, "还没有记忆动态");
  assert.equal(view.personaLine, "尚未配置人格 · 偏好不会写入人格");
  assert.equal(view.voiceNote, MEMORY_VOICE_NOTE);
});

test("memory snapshots reject unknown sections, missing actions and duplicate rows", () => {
  assert.throws(() => parseClientMemoryPage({ preferences: [], memories: [], persona: {} }));
  assert.throws(() =>
    parseClientMemoryPage({
      ...page,
      sections: page.sections.map((section) =>
        section.id === "project_application"
          ? {
              ...section,
              items: section.items.map((row) => ({ ...row, author: "model" })),
            }
          : section,
      ),
    }),
  );
  assert.throws(() =>
    parseClientMemoryPage({
      ...page,
      forgotten: page.forgotten.map((row) => ({ ...row, memoryId: "mem_agent" })),
    }),
  );
  assert.throws(() =>
    parseClientMemoryPage({
      ...page,
      sections: page.sections.filter((section) => section.id !== "task_experience"),
    }),
  );
});

test("preference and correction drafts are trimmed before they reach the host", () => {
  assert.deepEqual(validatePreferenceDraft("  语言  ", " zh-CN "), { key: "语言", value: "zh-CN" });
  assert.equal(validateCorrectionDraft("  仓库使用 pnpm  "), "仓库使用 pnpm");
  for (const [key, value] of [
    ["", "zh-CN"],
    ["语言", " "],
    ["语\n言", "zh-CN"],
    ["语言", "a".repeat(2001)],
  ] as const) {
    assert.throws(() => validatePreferenceDraft(key, value));
  }
  assert.throws(() => validateCorrectionDraft(" "));
});

test("memory errors stay short and do not invent a success", () => {
  assert.equal(readMemoryError("偏好内容无效"), "偏好内容无效");
  assert.equal(readMemoryError(new Error("找不到这条记录")), "找不到这条记录");
  assert.equal(readMemoryError({ secret: "token" }), "记忆操作失败");
});

test("memory times use Asia/Shanghai and name the timezone", () => {
  assert.equal(formatMemoryTime(0), "1970-01-01 08:00 Asia/Shanghai");
  assert.equal(formatMemoryTime(Date.UTC(2026, 0, 2, 16, 30)), "2026-01-03 00:30 Asia/Shanghai");
  assert.equal(formatMemoryTime(Number.NaN), "时间无效");
});

test("disabled and forgotten preferences point at restore instead of a silent duplicate", () => {
  const disabled = projectMemoryPanel(
    parseClientMemoryPage({
      ...page,
      sections: page.sections.map((section) =>
        section.id === "user_settings"
          ? {
              ...section,
              items: [
                item({
                  memoryId: "pref_disabled",
                  section: "user_settings",
                  recordKind: "preference",
                  summary: "语气：活泼",
                  preferenceKey: "语气",
                  preferenceValue: "活泼",
                  author: "user",
                  mutability: "user_readonly",
                  status: "disabled",
                  actions: { ...actions, disable: false, restore: true },
                }),
              ],
            }
          : section,
      ),
    }),
  );
  assert.equal(
    disabled.sections[0]?.items[0]?.restoreHint,
    "已停用。直接编辑并保存会重新生效，也可以先点恢复。",
  );
  const forgotten = projectMemoryPanel(
    parseClientMemoryPage({
      ...page,
      forgotten: [
        item({
          memoryId: "pref_forgotten",
          section: "user_settings",
          recordKind: "preference",
          summary: "字体：宋体",
          preferenceKey: "字体",
          preferenceValue: "宋体",
          author: "user",
          mutability: "user_readonly",
          status: "forgotten",
          actions: {
            correct: false,
            disable: false,
            forget: false,
            viewSource: true,
            restore: true,
          },
        }),
      ],
    }),
  );
  assert.equal(forgotten.forgotten[0]?.restoreHint, "已忘记。请先点恢复，再编辑这条偏好。");
});
