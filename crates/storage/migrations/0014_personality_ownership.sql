-- 人格是独立于六层记忆的版本化配置，不能和用户事实混在同一行。
-- Agent 不能成为作者。允许的修改只追加新版本，历史版本保持原文。
-- 本表不组装提示词。运行时顺序仍是 Host 策略 → 紧凑人格 → L1 → L0 → 渐进 L2–L5。

CREATE TABLE personality_records (
    personality_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'system')),
    mutability TEXT NOT NULL CHECK (
        mutability IN ('user_readonly', 'system_readonly')
    ),
    identity TEXT NOT NULL,
    tone TEXT NOT NULL,
    verbosity TEXT NOT NULL,
    language TEXT NOT NULL,
    initiative TEXT NOT NULL,
    behavior_boundary TEXT NOT NULL,
    tool_policy TEXT NOT NULL,
    voice TEXT NOT NULL,
    evolution_note TEXT,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (personality_id, version),
    CHECK (
        (author_kind = 'user' AND mutability = 'user_readonly') OR
        (author_kind = 'system' AND mutability = 'system_readonly')
    )
) STRICT;

-- 同一时刻只有一份生效人格，避免提示词组装时把多份配置叠在一起。
CREATE UNIQUE INDEX personality_records_one_active
    ON personality_records(active)
    WHERE active = 1;
