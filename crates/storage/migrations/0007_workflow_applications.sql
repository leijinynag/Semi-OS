-- 只由原生用户命令授予，执行前原子消费；重启不能重放可能已生效的 Git 操作。
CREATE TABLE workflow_applications (
    application_id TEXT PRIMARY KEY NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    status TEXT NOT NULL CHECK(status IN ('approved','executing','applied','unknown','reconciled')),
    updated_at_ms INTEGER NOT NULL
) STRICT;
