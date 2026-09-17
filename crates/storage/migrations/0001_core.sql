CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    task_run_id TEXT NOT NULL UNIQUE,
    trace_id TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    title TEXT,
    current_step TEXT,
    checkpoint_json TEXT,
    last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
    occurred_at_ms INTEGER NOT NULL,
    UNIQUE (task_id, sequence)
) STRICT;

CREATE INDEX task_events_task_order
    ON task_events(task_id, sequence);

CREATE TABLE agent_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    runtime_kind TEXT NOT NULL,
    runtime_session_ref TEXT,
    checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
    checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX agent_sessions_task
    ON agent_sessions(task_id);

CREATE TABLE tool_attempts (
    attempt_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    status TEXT NOT NULL CHECK (
        status IN ('started', 'succeeded', 'failed', 'unknown', 'cancelled', 'needs_user')
    ),
    risk_level TEXT NOT NULL CHECK (
        risk_level IN ('read', 'local_write', 'external_side_effect', 'privileged')
    ),
    input_digest TEXT NOT NULL,
    target_json TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
    policy_json TEXT CHECK (policy_json IS NULL OR json_valid(policy_json)),
    result_type TEXT CHECK (
        result_type IS NULL OR
        result_type IN ('success', 'failure', 'unknown', 'cancelled', 'needs_user')
    ),
    receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
    verification_json TEXT CHECK (
        verification_json IS NULL OR json_valid(verification_json)
    ),
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    UNIQUE (task_id, idempotency_key, attempt_number)
) STRICT;

CREATE INDEX tool_attempts_idempotency
    ON tool_attempts(task_id, idempotency_key, attempt_number DESC);

-- 同一幂等键最多只能产生一份成功回执，防止并发恢复路径重复确认副作用。
CREATE UNIQUE INDEX tool_attempts_one_success
    ON tool_attempts(task_id, idempotency_key)
    WHERE status = 'succeeded';

CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES tool_attempts(attempt_id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_json TEXT NOT NULL CHECK (json_valid(target_json)),
    payload_digest TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (
        decision IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')
    ),
    requested_at_ms INTEGER NOT NULL,
    decided_at_ms INTEGER
) STRICT;

CREATE INDEX approvals_task_decision
    ON approvals(task_id, decision);

CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES tool_attempts(attempt_id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    media_type TEXT,
    digest TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX artifacts_task
    ON artifacts(task_id, created_at_ms);

CREATE TABLE settings (
    setting_key TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    value_type TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE capabilities (
    capability_key TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('available', 'degraded', 'unavailable', 'unknown')
    ),
    reason TEXT,
    details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
    observed_at_ms INTEGER NOT NULL
) STRICT;
