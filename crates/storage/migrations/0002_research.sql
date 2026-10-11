-- 正文作为数据库内 Artifact 保存，避免 Worker 指定路径越过 Host 文件权限。
ALTER TABLE artifacts ADD COLUMN content_text TEXT;
CREATE TABLE research_sources (
    source_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    artifact_id TEXT REFERENCES artifacts(artifact_id),
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    collected_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE research_reports (
    task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(task_id),
    report_json TEXT NOT NULL CHECK(json_valid(report_json))
) STRICT;
