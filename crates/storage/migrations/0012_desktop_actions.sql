-- Desktop actions contain digests and safe summaries, never raw text or native pointers.
CREATE TABLE desktop_actions (
    request_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    approval_id TEXT UNIQUE,
    input_digest TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('not_dispatched','possibly_dispatched','verified','unknown','needs_user','failure')),
    summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;
