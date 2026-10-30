/**
 * 记忆页只消费 Host 快照。能否编辑由作者和可变更性决定，不解析模型散文。
 * 人格指纹单独展示，偏好正文不能写进人格行。
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

export type MemoryAuthor = (typeof MEMORY_AUTHORS)[number];
export type MemoryMutability = (typeof MEMORY_MUTABILITIES)[number];
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];
export type MemoryRecordKind = (typeof MEMORY_RECORD_KINDS)[number];

export interface ClientPreferenceRow {
  memoryId: string;
  key: string;
  value: string;
  author: MemoryAuthor;
  mutability: MemoryMutability;
  updatedAtMs: number;
}

export interface ClientMemoryRow {
  memoryId: string;
  layer: MemoryLayer;
  recordKind: MemoryRecordKind;
  summary: string;
  author: MemoryAuthor;
  mutability: MemoryMutability;
  updatedAtMs: number;
}

export interface ClientPersonaFingerprint {
  personalityId: string;
  version: number;
  author: MemoryAuthor;
  mutability: MemoryMutability;
}

export interface ClientMemoryPage {
  preferences: ClientPreferenceRow[];
  memories: ClientMemoryRow[];
  persona: ClientPersonaFingerprint | null;
}

export interface MemoryPanelPreference {
  memoryId: string;
  key: string;
  value: string;
  authorLabel: string;
  mutabilityLabel: string;
  ownership: string;
  editable: boolean;
}

export interface MemoryPanelMemory {
  memoryId: string;
  layer: MemoryLayer;
  recordKind: MemoryRecordKind;
  summary: string;
  authorLabel: string;
  mutabilityLabel: string;
  ownership: string;
  editable: false;
}

export interface MemoryPanelView {
  preferences: MemoryPanelPreference[];
  memories: MemoryPanelMemory[];
  personaLine: string;
  preferenceEmpty: string | null;
  memoryEmpty: string | null;
}

const MAX_PREFERENCE_CHARS = 2000;

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

export function preferenceEditable(row: ClientPreferenceRow): boolean {
  return row.author === "user" && row.mutability === "user_readonly";
}

export function projectMemoryPanel(page: ClientMemoryPage): MemoryPanelView {
  return {
    preferences: page.preferences.map((row) => ({
      memoryId: row.memoryId,
      key: row.key,
      value: row.value,
      authorLabel: authorLabel(row.author),
      mutabilityLabel: mutabilityLabel(row.mutability),
      ownership: `${row.author} / ${row.mutability}`,
      editable: preferenceEditable(row),
    })),
    memories: page.memories.map((row) => ({
      memoryId: row.memoryId,
      layer: row.layer,
      recordKind: row.recordKind,
      summary: row.summary,
      authorLabel: authorLabel(row.author),
      mutabilityLabel: mutabilityLabel(row.mutability),
      ownership: `${row.author} / ${row.mutability}`,
      editable: false,
    })),
    personaLine: personaLine(page.persona),
    preferenceEmpty: page.preferences.length === 0 ? "还没有自己的偏好。" : null,
    memoryEmpty: page.memories.length === 0 ? "还没有可查看的记忆。" : null,
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

export function readMemoryError(reason: unknown): string {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return "记忆操作失败";
}

export function parseClientMemoryPage(value: unknown): ClientMemoryPage {
  if (!isRecord(value) || !Array.isArray(value.preferences) || !Array.isArray(value.memories)) {
    throw new Error("记忆快照无效");
  }
  const preferences = value.preferences.map(parsePreference);
  const memories = value.memories.map(parseMemory);
  const ids = [...preferences, ...memories].map((row) => row.memoryId);
  if (new Set(ids).size !== ids.length) throw new Error("记忆快照无效");
  return {
    preferences,
    memories,
    persona: parsePersona(value.persona),
  };
}

function personaLine(persona: ClientPersonaFingerprint | null): string {
  if (!persona) return "尚未配置人格。偏好不会写入人格。";
  return `人格 ${persona.personalityId} · 版本 ${persona.version} · ${authorLabel(persona.author)} · ${mutabilityLabel(persona.mutability)}`;
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

function parseMemory(value: unknown): ClientMemoryRow {
  if (
    !isRecord(value) ||
    !isMemoryId(value.memoryId) ||
    !isLayer(value.layer) ||
    !isRecordKind(value.recordKind) ||
    typeof value.summary !== "string" ||
    Array.from(value.summary).length > 240 ||
    !isAuthor(value.author) ||
    !isMutability(value.mutability) ||
    !isTimestamp(value.updatedAtMs)
  ) {
    throw new Error("记忆快照无效");
  }
  return {
    memoryId: value.memoryId,
    layer: value.layer,
    recordKind: value.recordKind,
    summary: value.summary,
    author: value.author,
    mutability: value.mutability,
    updatedAtMs: value.updatedAtMs,
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

function isMemoryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
