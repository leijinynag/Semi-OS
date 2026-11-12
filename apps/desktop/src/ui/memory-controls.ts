/**
 * 记忆页只消费 Host 快照。分节、状态和可执行动作都由 Host 给出，
 * 界面不解析模型散文，也不据此推断任务成败。
 * 用户写过的记录对 Agent 只读；写入和召回只出现在这一页，不走语音。
 */

export const MEMORY_AUTHORS = ["user", "agent", "system"] as const;
export const MEMORY_MUTABILITIES = ["user_readonly", "agent_mutable", "system_readonly"] as const;
export const MEMORY_LAYERS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export const MEMORY_RECORD_KINDS = [
  "pi_session",
  "recent_turn",
  "current_plan",
  "compaction_summary",
  "safety_rule",
  "tool_boundary",
  "confirmation_policy",
  "profile",
  "preference",
  "project_fact",
  "application_habit",
  "task_summary",
  "decision",
  "verified_outcome",
  "message_evidence",
  "task_event_evidence",
  "artifact_evidence",
  "receipt_evidence",
  "workflow_candidate",
  "skill_candidate",
] as const;
export const MEMORY_SOURCE_KINDS = [
  "task",
  "task_event",
  "conversation_turn",
  "artifact",
  "receipt",
  "user_entry",
  "system",
  "pi_session",
] as const;
export const MEMORY_SECTION_IDS = [
  "user_settings",
  "agent_learned",
  "project_application",
  "task_experience",
  "unverified_workflow",
  "other",
] as const;
export const REQUIRED_MEMORY_SECTIONS = [
  "user_settings",
  "agent_learned",
  "project_application",
  "task_experience",
  "unverified_workflow",
] as const;
export const MEMORY_STATUSES = [
  "active",
  "disabled",
  "forgotten",
  "superseded",
  "conflict_inactive",
] as const;
export const MEMORY_ACTIVITY_KINDS = [
  "recalled",
  "written",
  "corrected",
  "disabled",
  "forgotten",
  "restored",
  "write_failed",
] as const;

/** Host 命令名。组件只通过这些名字调用，测试据此确认动作已经接上。 */
export const MEMORY_COMMANDS = {
  list: "list_client_memory",
  createPreference: "create_user_preference",
  revisePreference: "revise_user_preference",
  deletePreference: "delete_user_preference",
  correct: "correct_client_memory",
  disable: "disable_client_memory",
  forget: "forget_client_memory",
  restore: "restore_client_memory",
} as const;

export const MEMORY_VOICE_NOTE = "写入和召回只显示在这页的记忆动态里，不会语音播报。";

export type MemoryAuthor = (typeof MEMORY_AUTHORS)[number];
export type MemoryMutability = (typeof MEMORY_MUTABILITIES)[number];
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export type MemoryRecordKind = (typeof MEMORY_RECORD_KINDS)[number];
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];
export type MemorySectionId = (typeof MEMORY_SECTION_IDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryActivityKind = (typeof MEMORY_ACTIVITY_KINDS)[number];

export interface ClientPreferenceRow {
  memoryId: string;
  key: string;
  value: string;
  author: MemoryAuthor;
  mutability: MemoryMutability;
  updatedAtMs: number;
}

export interface ClientMemorySource {
  sourceId: string;
  kind: MemorySourceKind;
  sourceRef: string;
  note: string | null;
  createdAtMs: number;
}

export interface ClientMemoryActions {
  correct: boolean;
  disable: boolean;
  forget: boolean;
  viewSource: boolean;
  restore: boolean;
}

export interface ClientMemoryItem {
  memoryId: string;
  section: MemorySectionId;
  layer: MemoryLayer;
  recordKind: MemoryRecordKind;
  summary: string;
  preferenceKey: string | null;
  preferenceValue: string | null;
  sources: ClientMemorySource[];
  scopeLabel: string;
  author: MemoryAuthor;
  mutability: MemoryMutability;
  updatedAtMs: number;
  lastRecalledAtMs: number | null;
  recallReason: string | null;
  status: MemoryStatus;
  hasConflict: boolean;
  actions: ClientMemoryActions;
}

export interface ClientMemorySection {
  id: MemorySectionId;
  items: ClientMemoryItem[];
}

export interface ClientMemoryActivity {
  activityId: string;
  memoryId: string | null;
  kind: MemoryActivityKind;
  summary: string;
  createdAtMs: number;
}

export interface ClientPersonaFingerprint {
  personalityId: string;
  version: number;
  author: MemoryAuthor;
  mutability: MemoryMutability;
}

export interface ClientMemoryPage {
  preferences: ClientPreferenceRow[];
  sections: ClientMemorySection[];
  forgotten: ClientMemoryItem[];
  activity: ClientMemoryActivity[];
  persona: ClientPersonaFingerprint | null;
}

export interface MemoryPanelPreference {
  memoryId: string;
  key: string;
  value: string;
  authorLabel: string;
  mutabilityLabel: string;
  metaLabel: string;
  ownership: string;
  editable: boolean;
}

export interface MemoryPanelItem {
  memoryId: string;
  section: MemorySectionId;
  summary: string;
  preferenceKey: string | null;
  preferenceValue: string | null;
  sourceLines: string[];
  scopeLabel: string;
  authorLabel: string;
  mutabilityLabel: string;
  updatedLabel: string;
  recalledLabel: string;
  recallReason: string | null;
  statusLabel: string;
  conflictLabel: string;
  restoreHint: string | null;
  actions: ClientMemoryActions;
  editablePreference: boolean;
}

export interface MemoryPanelSection {
  id: MemorySectionId;
  title: string;
  empty: string | null;
  items: MemoryPanelItem[];
}

export interface MemoryPanelActivity {
  activityId: string;
  label: string;
  summary: string;
  timeLabel: string;
}

export interface MemoryPanelView {
  preferences: MemoryPanelPreference[];
  sections: MemoryPanelSection[];
  forgotten: MemoryPanelItem[];
  forgottenTitle: string;
  activity: MemoryPanelActivity[];
  activityEmpty: string | null;
  personaLine: string;
  voiceNote: string;
  preferenceEmpty: string | null;
}

const MAX_PREFERENCE_CHARS = 2000;
const MAX_SUMMARY_CHARS = 240;
const MAX_SOURCE_REF_CHARS = 2000;
const MAX_NOTE_CHARS = 500;

export function authorLabel(author: MemoryAuthor): string {
  switch (author) {
    case "user":
      return "用户";
    case "agent":
      return "Agent";
    case "system":
      return "系统";
  }
}

export function mutabilityLabel(mutability: MemoryMutability): string {
  switch (mutability) {
    case "user_readonly":
      return "用户可改，Agent 只读";
    case "agent_mutable":
      return "Agent 可改";
    case "system_readonly":
      return "系统只读";
  }
}

export function sectionTitle(id: MemorySectionId): string {
  switch (id) {
    case "user_settings":
      return "用户设置";
    case "agent_learned":
      return "Agent 学到的";
    case "project_application":
      return "项目与应用经验";
    case "task_experience":
      return "任务经验";
    case "unverified_workflow":
      return "未验证工作流";
    case "other":
      return "其他记录";
  }
}

export function sectionEmpty(id: MemorySectionId): string {
  switch (id) {
    case "user_settings":
      return "还没有用户设置";
    case "agent_learned":
      return "还没有 Agent 学到的内容";
    case "project_application":
      return "还没有项目或应用经验";
    case "task_experience":
      return "还没有任务经验";
    case "unverified_workflow":
      return "还没有未验证工作流";
    case "other":
      return "没有其他记录";
  }
}

export function statusLabel(status: MemoryStatus): string {
  switch (status) {
    case "active":
      return "生效中";
    case "disabled":
      return "已停用";
    case "forgotten":
      return "已忘记";
    case "superseded":
      return "已被替代";
    case "conflict_inactive":
      return "冲突未生效";
  }
}

export function activityLabel(kind: MemoryActivityKind): string {
  switch (kind) {
    case "recalled":
      return "召回";
    case "written":
      return "写入";
    case "corrected":
      return "纠正";
    case "disabled":
      return "停用";
    case "forgotten":
      return "忘记";
    case "restored":
      return "恢复";
    case "write_failed":
      return "写入失败";
  }
}

export function sourceKindLabel(kind: MemorySourceKind): string {
  switch (kind) {
    case "task":
      return "任务";
    case "task_event":
      return "任务事件";
    case "conversation_turn":
      return "对话";
    case "artifact":
      return "产物";
    case "receipt":
      return "回执";
    case "user_entry":
      return "用户录入";
    case "system":
      return "系统";
    case "pi_session":
      return "会话";
  }
}

export function preferenceEditable(row: ClientPreferenceRow): boolean {
  return row.author === "user" && row.mutability === "user_readonly";
}

/** 记忆页固定用上海时间，并写明时区，避免把 UTC 显示成本地时间。 */
export const MEMORY_TIME_ZONE = "Asia/Shanghai";

export function formatMemoryTime(ms: number): string {
  if (!Number.isFinite(ms)) return "时间无效";
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: MEMORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return `${formatted} ${MEMORY_TIME_ZONE}`;
}

export function preferenceRestoreHint(row: {
  status: MemoryStatus;
  preferenceKey: string | null;
}): string | null {
  if (!row.preferenceKey) return null;
  if (row.status === "disabled") {
    return "已停用。直接编辑并保存会重新生效，也可以先点恢复。";
  }
  if (row.status === "forgotten") {
    return "已忘记。请先点恢复，再编辑这条偏好。";
  }
  return null;
}

export function projectMemoryPanel(page: ClientMemoryPage): MemoryPanelView {
  return {
    preferences: page.preferences.map((row) => ({
      memoryId: row.memoryId,
      key: row.key,
      value: row.value,
      authorLabel: authorLabel(row.author),
      mutabilityLabel: mutabilityLabel(row.mutability),
      metaLabel: preferenceMetaLabel(row),
      ownership: `${row.author} / ${row.mutability}`,
      editable: preferenceEditable(row),
    })),
    sections: page.sections.map((section) => ({
      id: section.id,
      title: sectionTitle(section.id),
      empty: section.items.length === 0 ? sectionEmpty(section.id) : null,
      items: section.items.map(panelItem),
    })),
    forgotten: page.forgotten.map(panelItem),
    forgottenTitle: "可恢复",
    activity: page.activity.map((row) => ({
      activityId: row.activityId,
      label: activityLabel(row.kind),
      summary: row.summary,
      timeLabel: formatMemoryTime(row.createdAtMs),
    })),
    activityEmpty: page.activity.length === 0 ? "还没有记忆动态" : null,
    personaLine: personaLine(page.persona),
    voiceNote: MEMORY_VOICE_NOTE,
    preferenceEmpty: page.preferences.length === 0 ? "还没有偏好" : null,
  };
}

export function validatePreferenceDraft(
  key: string,
  value: string,
): { key: string; value: string } {
  const nextKey = cleanPreferenceText(key, "偏好名称");
  const nextValue = cleanPreferenceText(value, "偏好内容");
  return { key: nextKey, value: nextValue };
}

export function validateCorrectionDraft(text: string): string {
  return cleanPreferenceText(text, "纠正内容");
}

export function readMemoryError(reason: unknown): string {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return "记忆操作失败";
}

export function parseClientMemoryPage(value: unknown): ClientMemoryPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.preferences) ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.forgotten) ||
    !Array.isArray(value.activity)
  ) {
    throw new Error("记忆快照无效");
  }
  const preferences = value.preferences.map(parsePreference);
  const sections = value.sections.map(parseSection);
  const forgotten = value.forgotten.map(parseItem);
  const activity = value.activity.map(parseActivity);
  const required = new Set(sections.map((section) => section.id));
  if (
    REQUIRED_MEMORY_SECTIONS.some((id) => !required.has(id)) ||
    new Set(sections.map((section) => section.id)).size !== sections.length
  ) {
    throw new Error("记忆快照无效");
  }
  const ids = [...sections.flatMap((section) => section.items), ...forgotten].map(
    (row) => row.memoryId,
  );
  if (new Set(ids).size !== ids.length) throw new Error("记忆快照无效");
  return {
    preferences,
    sections,
    forgotten,
    activity,
    persona: parsePersona(value.persona),
  };
}

function panelItem(row: ClientMemoryItem): MemoryPanelItem {
  return {
    memoryId: row.memoryId,
    section: row.section,
    summary: row.summary,
    preferenceKey: row.preferenceKey,
    preferenceValue: row.preferenceValue,
    sourceLines:
      row.sources.length === 0
        ? ["没有来源记录"]
        : row.sources.map((source) => {
            const note = source.note ? ` · ${source.note}` : "";
            return `${sourceKindLabel(source.kind)} ${source.sourceRef}${note}`;
          }),
    scopeLabel: row.scopeLabel,
    authorLabel: authorLabel(row.author),
    mutabilityLabel: mutabilityLabel(row.mutability),
    updatedLabel: formatMemoryTime(row.updatedAtMs),
    recalledLabel:
      row.lastRecalledAtMs == null ? "尚未召回" : formatMemoryTime(row.lastRecalledAtMs),
    recallReason: row.recallReason,
    statusLabel: statusLabel(row.status),
    conflictLabel: row.hasConflict ? "有冲突" : "无冲突",
    restoreHint: preferenceRestoreHint(row),
    actions: row.actions,
    editablePreference:
      row.section === "user_settings" &&
      row.author === "user" &&
      row.mutability === "user_readonly" &&
      row.preferenceKey != null &&
      row.preferenceValue != null &&
      row.status !== "forgotten",
  };
}

function preferenceMetaLabel(row: ClientPreferenceRow): string {
  if (preferenceEditable(row)) return "你可改 · Agent 只读";
  return `${authorLabel(row.author)} · ${mutabilityLabel(row.mutability)}`;
}

function personaLine(persona: ClientPersonaFingerprint | null): string {
  if (!persona) return "尚未配置人格 · 偏好不会写入人格";
  return `人格 ${persona.personalityId} · 版本 ${persona.version} · ${authorLabel(persona.author)} · ${mutabilityLabel(persona.mutability)} · 偏好不会写入人格`;
}

function cleanPreferenceText(value: string, label: string): string {
  const text = value.trim();
  if (
    !text ||
    Array.from(text).length > MAX_PREFERENCE_CHARS ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw new Error(`${label}无效`);
  }
  return text;
}

function parsePreference(value: unknown): ClientPreferenceRow {
  if (
    !isRecord(value) ||
    !isMemoryId(value.memoryId) ||
    typeof value.key !== "string" ||
    typeof value.value !== "string" ||
    !isAuthor(value.author) ||
    !isMutability(value.mutability) ||
    !isTimestamp(value.updatedAtMs) ||
    Array.from(value.key).length > MAX_PREFERENCE_CHARS ||
    Array.from(value.value).length > MAX_PREFERENCE_CHARS
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    memoryId: value.memoryId,
    key: value.key,
    value: value.value,
    author: value.author,
    mutability: value.mutability,
    updatedAtMs: value.updatedAtMs,
  };
}

function parseSection(value: unknown): ClientMemorySection {
  if (!isRecord(value) || !isSectionId(value.id) || !Array.isArray(value.items)) {
    throw new Error("记忆快照无效");
  }
  const items = value.items.map(parseItem);
  if (items.some((item) => item.section !== value.id)) throw new Error("记忆快照无效");
  return { id: value.id, items };
}

function parseItem(value: unknown): ClientMemoryItem {
  if (
    !isRecord(value) ||
    !isMemoryId(value.memoryId) ||
    !isSectionId(value.section) ||
    !isLayer(value.layer) ||
    !isRecordKind(value.recordKind) ||
    typeof value.summary !== "string" ||
    Array.from(value.summary).length > MAX_SUMMARY_CHARS ||
    !isOptionalText(value.preferenceKey, MAX_PREFERENCE_CHARS) ||
    !isOptionalText(value.preferenceValue, MAX_PREFERENCE_CHARS) ||
    !Array.isArray(value.sources) ||
    typeof value.scopeLabel !== "string" ||
    Array.from(value.scopeLabel).length > 500 ||
    !isAuthor(value.author) ||
    !isMutability(value.mutability) ||
    !isTimestamp(value.updatedAtMs) ||
    !isOptionalTimestamp(value.lastRecalledAtMs) ||
    !isOptionalText(value.recallReason, 40) ||
    !isStatus(value.status) ||
    typeof value.hasConflict !== "boolean" ||
    !isActions(value.actions)
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    memoryId: value.memoryId,
    section: value.section,
    layer: value.layer,
    recordKind: value.recordKind,
    summary: value.summary,
    preferenceKey: optionalText(value.preferenceKey),
    preferenceValue: optionalText(value.preferenceValue),
    sources: value.sources.map(parseSource),
    scopeLabel: value.scopeLabel,
    author: value.author,
    mutability: value.mutability,
    updatedAtMs: value.updatedAtMs,
    lastRecalledAtMs: optionalTimestamp(value.lastRecalledAtMs),
    recallReason: optionalText(value.recallReason),
    status: value.status,
    hasConflict: value.hasConflict,
    actions: value.actions,
  };
}

function parseSource(value: unknown): ClientMemorySource {
  if (
    !isRecord(value) ||
    !isMemoryId(value.sourceId) ||
    !isSourceKind(value.kind) ||
    typeof value.sourceRef !== "string" ||
    Array.from(value.sourceRef).length > MAX_SOURCE_REF_CHARS ||
    !isOptionalText(value.note, MAX_NOTE_CHARS) ||
    !isTimestamp(value.createdAtMs)
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    sourceId: value.sourceId,
    kind: value.kind,
    sourceRef: value.sourceRef,
    note: optionalText(value.note),
    createdAtMs: value.createdAtMs,
  };
}

function parseActivity(value: unknown): ClientMemoryActivity {
  if (
    !isRecord(value) ||
    !isMemoryId(value.activityId) ||
    !isOptionalMemoryId(value.memoryId) ||
    !isActivityKind(value.kind) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    Array.from(value.summary).length > 200 ||
    !isTimestamp(value.createdAtMs)
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    activityId: value.activityId,
    memoryId: optionalMemoryId(value.memoryId),
    kind: value.kind,
    summary: value.summary,
    createdAtMs: value.createdAtMs,
  };
}

function parsePersona(value: unknown): ClientPersonaFingerprint | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("记忆快照无效");
  const version = value.version;
  if (
    !isMemoryId(value.personalityId) ||
    !isVersion(version) ||
    !isAuthor(value.author) ||
    !isMutability(value.mutability)
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    personalityId: value.personalityId,
    version,
    author: value.author,
    mutability: value.mutability,
  };
}

function isActions(value: unknown): value is ClientMemoryActions {
  return (
    isRecord(value) &&
    typeof value.correct === "boolean" &&
    typeof value.disable === "boolean" &&
    typeof value.forget === "boolean" &&
    typeof value.viewSource === "boolean" &&
    typeof value.restore === "boolean"
  );
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isAuthor(value: unknown): value is MemoryAuthor {
  return typeof value === "string" && MEMORY_AUTHORS.some((author) => author === value);
}

function isMutability(value: unknown): value is MemoryMutability {
  return (
    typeof value === "string" && MEMORY_MUTABILITIES.some((mutability) => mutability === value)
  );
}

function isLayer(value: unknown): value is MemoryLayer {
  return typeof value === "string" && MEMORY_LAYERS.some((layer) => layer === value);
}

function isRecordKind(value: unknown): value is MemoryRecordKind {
  return typeof value === "string" && MEMORY_RECORD_KINDS.some((kind) => kind === value);
}

function isSourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === "string" && MEMORY_SOURCE_KINDS.some((kind) => kind === value);
}

function isSectionId(value: unknown): value is MemorySectionId {
  return typeof value === "string" && MEMORY_SECTION_IDS.some((id) => id === value);
}

function isStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && MEMORY_STATUSES.some((status) => status === value);
}

function isActivityKind(value: unknown): value is MemoryActivityKind {
  return typeof value === "string" && MEMORY_ACTIVITY_KINDS.some((kind) => kind === value);
}

function isMemoryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isOptionalMemoryId(value: unknown): boolean {
  return value == null || isMemoryId(value);
}

function optionalMemoryId(value: unknown): string | null {
  return value == null ? null : (value as string);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value == null || isTimestamp(value);
}

function optionalTimestamp(value: unknown): number | null {
  return value == null ? null : (value as number);
}

function isOptionalText(value: unknown, max: number): boolean {
  if (value == null) return true;
  return typeof value === "string" && Array.from(value).length <= max;
}

function optionalText(value: unknown): string | null {
  return value == null ? null : (value as string);
}
