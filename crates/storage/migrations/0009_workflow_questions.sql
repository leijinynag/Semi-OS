-- 结构化决策请求独立迁移，已应用后台 schema 的本地数据库也能安全升级。
CREATE TABLE workflow_decision_requests (
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    request_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
    intent_version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('clarification','plan')),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','needs_user')),
    PRIMARY KEY(workflow_id,request_id)
) STRICT;
