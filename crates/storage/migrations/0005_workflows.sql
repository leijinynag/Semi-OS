CREATE TABLE workflow_plans (
    workflow_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    session_id TEXT NOT NULL,
    intent_version INTEGER NOT NULL CHECK(intent_version > 0),
    digest TEXT NOT NULL,
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, version)
) STRICT;
CREATE TABLE workflows (
    workflow_id TEXT PRIMARY KEY NOT NULL,
    current_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'awaiting_approval','approved','rejected','needs_revision','paused','cancelled','unknown'
    )),
    last_sequence INTEGER NOT NULL DEFAULT 0,
    consumed_sequence INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(workflow_id,current_version) REFERENCES workflow_plans(workflow_id,version)
) STRICT;
CREATE TABLE workflow_decisions (
    workflow_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','needs_revision')),
    decided_at_ms INTEGER NOT NULL,
    PRIMARY KEY(workflow_id,plan_version),
    FOREIGN KEY(workflow_id,plan_version) REFERENCES workflow_plans(workflow_id,version)
) STRICT;
CREATE TABLE workflow_events (
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL CHECK(json_valid(event_json)),
    PRIMARY KEY(workflow_id,sequence)
) STRICT;
CREATE TABLE agent_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    workflow_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    work_item_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    run_json TEXT NOT NULL CHECK(json_valid(run_json)),
    UNIQUE(workflow_id,plan_version,work_item_id,attempt),
    FOREIGN KEY(workflow_id,plan_version) REFERENCES workflow_plans(workflow_id,version)
) STRICT;
CREATE INDEX workflow_session ON workflow_plans(session_id, workflow_id);
