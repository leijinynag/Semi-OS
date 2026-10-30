-- 六层记忆是独立于对话 transcript 的规范记录。
-- 每一行只能属于一个层；压缩摘要的种类只能落在 L0，不能晋升成长期记忆。
-- L4 保存证据指针，原始消息仍留在会话、任务事件和回执里。
-- 来源与关系分表，写入关系不得改写被指向记录的正文。
-- 作者与可变更性成对约束：用户记录不能被标成 Agent 可改。
-- 人格不在这些表里。后续组装顺序是 Host 策略 → 人格 → L1 → L0 → 渐进 L2–L5。

CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('L0', 'L1', 'L2', 'L3', 'L4', 'L5')),
    record_kind TEXT NOT NULL,
    content_json TEXT NOT NULL CHECK (
        json_valid(content_json) AND json_type(content_json) = 'object'
    ),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
    mutability TEXT NOT NULL CHECK (
        mutability IN ('user_readonly', 'agent_mutable', 'system_readonly')
    ),
    user_id TEXT,
    workspace_id TEXT,
    application_id TEXT,
    task_id TEXT,
    skill_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK (
        (author_kind = 'user' AND mutability = 'user_readonly') OR
        (author_kind = 'agent' AND mutability = 'agent_mutable') OR
        (author_kind = 'system' AND mutability = 'system_readonly')
    ),
    CHECK (
        (layer = 'L0' AND record_kind IN (
            'pi_session', 'recent_turn', 'current_plan', 'compaction_summary'
        )) OR
        (layer = 'L1' AND record_kind IN (
            'safety_rule', 'tool_boundary', 'confirmation_policy'
        )) OR
        (layer = 'L2' AND record_kind IN (
            'profile', 'preference', 'project_fact', 'application_habit'
        )) OR
        (layer = 'L3' AND record_kind IN (
            'task_summary', 'decision', 'verified_outcome'
        )) OR
        (layer = 'L4' AND record_kind IN (
            'message_evidence', 'task_event_evidence', 'artifact_evidence', 'receipt_evidence'
        )) OR
        (layer = 'L5' AND record_kind IN ('workflow_candidate', 'skill_candidate'))
    )
) STRICT;

CREATE INDEX memories_layer_created
    ON memories(layer, created_at_ms, memory_id);

CREATE INDEX memories_scope_user
    ON memories(user_id, layer);

CREATE INDEX memories_scope_workspace
    ON memories(workspace_id, layer);

CREATE INDEX memories_scope_task
    ON memories(task_id, layer);

CREATE TABLE memory_sources (
    source_id TEXT PRIMARY KEY NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'task', 'task_event', 'conversation_turn', 'artifact', 'receipt',
        'user_entry', 'system', 'pi_session'
    )),
    source_ref TEXT NOT NULL,
    note TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (memory_id, source_kind, source_ref)
) STRICT;

CREATE INDEX memory_sources_memory
    ON memory_sources(memory_id, created_at_ms, source_id);

CREATE TABLE memory_links (
    link_id TEXT PRIMARY KEY NOT NULL,
    from_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    to_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK (relation IN (
        'supersedes', 'contradicts', 'consolidates', 'associates'
    )),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (from_memory_id <> to_memory_id),
    UNIQUE (from_memory_id, to_memory_id, relation)
) STRICT;

CREATE INDEX memory_links_from
    ON memory_links(from_memory_id, created_at_ms, link_id);

CREATE INDEX memory_links_to
    ON memory_links(to_memory_id, created_at_ms, link_id);
