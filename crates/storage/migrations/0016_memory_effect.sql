-- 记忆是否继续生效，与正文、作者分开存放。
-- 缺行表示仍生效，且还没有被召回过。停用和忘记不删除正文，误操作可以恢复。
-- 召回只跳过 disabled / forgotten。用户原文不会因为这些状态被改写。
-- memory_activity 只给客户端记忆页的时间线，不进入语音事件。

CREATE TABLE memory_effect (
    memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    effect_status TEXT NOT NULL CHECK (effect_status IN ('active', 'disabled', 'forgotten')),
    last_recalled_at_ms INTEGER CHECK (last_recalled_at_ms IS NULL OR last_recalled_at_ms >= 0),
    last_recall_reason TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX memory_effect_status
    ON memory_effect(effect_status, memory_id);

CREATE TABLE memory_activity (
    activity_id TEXT PRIMARY KEY NOT NULL,
    memory_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN (
        'recalled', 'written', 'corrected', 'disabled', 'forgotten', 'restored', 'write_failed'
    )),
    summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX memory_activity_created
    ON memory_activity(created_at_ms DESC, activity_id DESC);
