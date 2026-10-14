CREATE TABLE IF NOT EXISTS workflow_evidence (
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    evidence_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('finding','integration')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    PRIMARY KEY(workflow_id,evidence_id)
) STRICT;
-- 快照可以更新，但每个证据版本必须追加保留，不能用“已解决”覆盖问题历史。
CREATE TABLE workflow_evidence_history (
    workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY(workflow_id,sequence)
) STRICT;
