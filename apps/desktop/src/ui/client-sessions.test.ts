import assert from "node:assert/strict";
import test from "node:test";
import { parseClientSessions, validateSessionTitle } from "./client-sessions.ts";

test("session list requires one active selection and unique identities", () => {
  const session = { sessionId: "session_default", title: "默认会话", createdAtMs: 1, active: true };
  assert.deepEqual(parseClientSessions([session]), [session]);
  for (const invalid of [
    [],
    [session, session],
    [{ ...session, active: false }],
    [{ ...session, active: "yes" }],
  ]) {
    assert.throws(() => parseClientSessions(invalid));
  }
});

test("session titles are trimmed and bounded in UTF-16 units", () => {
  assert.equal(validateSessionTitle("  项目讨论  "), "项目讨论");
  assert.equal(validateSessionTitle("😀".repeat(40)).length, 80);
  for (const title of [" ", "a".repeat(81), "😀".repeat(41), "a\nb", "a\u0085b"]) {
    assert.throws(() => validateSessionTitle(title));
  }
});
