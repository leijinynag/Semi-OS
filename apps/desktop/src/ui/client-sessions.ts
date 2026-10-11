/** Host 是 Session 选择与持久化的唯一权威；UI 不从 TaskRun 推导会话列表。 */
export interface ClientSession {
  sessionId: string;
  title: string;
  createdAtMs: number;
  active: boolean;
}

export function validateSessionTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    throw new Error("名称不能为空，且不能超过 80 个字符或包含控制字符");
  }
  return title;
}

export function parseClientSessions(value: unknown): ClientSession[] {
  if (!Array.isArray(value) || !value.every((item) =>
    item && typeof item === "object" &&
    typeof item.sessionId === "string" && item.sessionId.length > 0 &&
    typeof item.title === "string" && Number.isSafeInteger(item.createdAtMs) &&
    typeof item.active === "boolean")) throw new Error("无效的会话列表");
  const sessions = value as ClientSession[];
  if (new Set(sessions.map((item) => item.sessionId)).size !== sessions.length ||
    sessions.filter((item) => item.active).length !== 1) throw new Error("无效的会话选择");
  return sessions;
}
