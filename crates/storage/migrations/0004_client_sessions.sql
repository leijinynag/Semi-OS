-- 已有轮次归入默认展示会话，保留 conversation_json 中原始运行身份以便审计。
CREATE TABLE client_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX client_sessions_one_active ON client_sessions(active) WHERE active = 1;
INSERT INTO client_sessions VALUES('session_default', '默认会话', unixepoch('subsec') * 1000, 1);
-- 有历史数据且开启外键时，SQLite 不允许直接添加带非空默认值的 REFERENCES 列。
-- 在迁移事务内重建表，保留原始 JSON 与时间，显式建立归档关系。
ALTER TABLE conversation_turns RENAME TO conversation_turns_legacy;
CREATE TABLE conversation_turns (
    request_id TEXT PRIMARY KEY NOT NULL,
    conversation_json TEXT NOT NULL CHECK(json_valid(conversation_json)),
    updated_at_ms INTEGER NOT NULL,
    session_id TEXT NOT NULL DEFAULT 'session_default' REFERENCES client_sessions(session_id)
) STRICT;
INSERT INTO conversation_turns(request_id,conversation_json,updated_at_ms,session_id)
    SELECT request_id,conversation_json,updated_at_ms,'session_default' FROM conversation_turns_legacy;
DROP TABLE conversation_turns_legacy;
CREATE INDEX conversation_turns_session ON conversation_turns(session_id, updated_at_ms);
