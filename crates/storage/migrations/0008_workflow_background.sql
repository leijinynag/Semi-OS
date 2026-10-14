-- 托管批准、协调领取及启动回执均归 Host；Worker 不持有数据库。
CREATE TABLE workflow_grants (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(workflow_id),
    intent_version INTEGER NOT NULL,
    plan_version INTEGER NOT NULL,
    digest TEXT NOT NULL,
    repository TEXT NOT NULL,
    actions_json TEXT NOT NULL CHECK(json_valid(actions_json)),
    approved_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE workflow_coordinators (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(workflow_id),
    owner TEXT,
    lease_until_ms INTEGER NOT NULL DEFAULT 0,
    claimed_sequence INTEGER NOT NULL DEFAULT 0,
    consumed_sequence INTEGER NOT NULL DEFAULT 0,
    checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
    execution_status TEXT NOT NULL DEFAULT 'idle'
        CHECK(execution_status IN ('idle','coordinating','running','needs_user','completed')),
    no_progress INTEGER NOT NULL DEFAULT 0,
    last_activity_ms INTEGER NOT NULL DEFAULT 0,
    reason TEXT
) STRICT;
CREATE TABLE workflow_run_phases (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(run_id),
    phase TEXT NOT NULL CHECK(phase IN ('not_started','start_requested','executing','saved')),
    updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE workflow_delegate_decisions (
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    request_id TEXT NOT NULL,
    intent_version INTEGER NOT NULL,
    decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
    decided_at_ms INTEGER NOT NULL,
    PRIMARY KEY(workflow_id,request_id)
) STRICT;
