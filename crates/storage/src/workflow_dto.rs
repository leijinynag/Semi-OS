use crate::{StorageError, StorageResult};
use semi_os_protocol::{
    AgentRun, AuthorizedAction, IntegrationResult, ReviewFinding, WorkflowPlan,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// 工作流时间线事件的稳定查询投影。
///
/// 数据库仍以 JSON 保存历史事件，但客户端只能拿到这个经过反序列化和
/// 字段约束的 DTO，不能把数据库里的任意 JSON 当成 UI 协议。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowEventRecord {
    pub event_id: String,
    pub sequence: i64,
    pub kind: String,
    pub occurred_at_ms: i64,
    pub plan_version: u32,
    pub intent_version: u32,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowDecisionKind {
    Clarification,
    Plan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowQuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowQuestion {
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<WorkflowQuestionOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
}

/// Provider 的问题输入只允许当前 UI 支持的结构化字段。
///
/// 不能为了兼容未知 Provider 输出而把整个 input 重新暴露成 Value；新字段
/// 应先扩展这里并补充契约测试。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDecisionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<WorkflowQuestion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDecisionRequest {
    pub request_id: String,
    pub run_id: String,
    pub kind: WorkflowDecisionKind,
    pub input: WorkflowDecisionInput,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCoordinator {
    pub execution_status: String,
    pub last_activity_at_ms: i64,
    pub no_progress: u32,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowGrant {
    pub intent_version: u32,
    pub approved_plan_version: u32,
    pub digest: String,
    pub repository: String,
    pub actions: Vec<AuthorizedAction>,
    pub approved_at_ms: i64,
    pub actor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBackground {
    pub coordinator: WorkflowCoordinator,
    pub grant: Option<WorkflowGrant>,
    pub requests: Vec<WorkflowDecisionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSnapshotDto {
    pub plan: WorkflowPlan,
    pub digest: String,
    pub status: String,
    pub runs: Vec<AgentRun>,
    pub events: Vec<WorkflowEventRecord>,
    pub findings: Vec<ReviewFinding>,
    pub integration: Option<IntegrationResult>,
    pub background: WorkflowBackground,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNotification {
    pub workflow_id: String,
    pub event: WorkflowEventRecord,
}

/// Pi 检查点的身份与序号由 Storage 校验；data 是 Runtime 自有的版本化状态，
/// 不参与工作流授权判断，因此只在这一明确的持久化边界保留 JSON 对象。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCheckpoint {
    pub session_id: String,
    pub sequence: u64,
    pub data: BTreeMap<String, Value>,
}

/// 领取成功与未领取是不同结果，不能用一组可选字段表示半个成功回执。
/// 自定义 serde 仅用于兼容 Worker 已有的布尔 claimed discriminator。
#[derive(Debug, Clone)]
pub enum WorkflowClaimResult {
    Unclaimed {
        needs_user: bool,
    },
    Claimed {
        sequence: i64,
        snapshot: Box<WorkflowSnapshotDto>,
        events: Vec<WorkflowEventRecord>,
        checkpoint: Option<WorkflowCheckpoint>,
    },
}

impl Serialize for WorkflowClaimResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        match self {
            Self::Unclaimed { needs_user } => {
                let mut wire = serializer
                    .serialize_struct("WorkflowClaim", if *needs_user { 2 } else { 1 })?;
                wire.serialize_field("claimed", &false)?;
                if *needs_user {
                    wire.serialize_field("needsUser", &true)?;
                }
                wire.end()
            }
            Self::Claimed {
                sequence,
                snapshot,
                events,
                checkpoint,
            } => {
                let mut wire = serializer.serialize_struct("WorkflowClaim", 5)?;
                wire.serialize_field("claimed", &true)?;
                wire.serialize_field("sequence", sequence)?;
                wire.serialize_field("snapshot", snapshot)?;
                wire.serialize_field("events", events)?;
                wire.serialize_field("checkpoint", checkpoint)?;
                wire.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for WorkflowClaimResult {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            claimed: bool,
            needs_user: Option<bool>,
            sequence: Option<i64>,
            snapshot: Option<WorkflowSnapshotDto>,
            events: Option<Vec<WorkflowEventRecord>>,
            checkpoint: Option<WorkflowCheckpoint>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let malformed = || serde::de::Error::custom("invalid workflow claim receipt");
        if !wire.claimed {
            if wire.sequence.is_some()
                || wire.snapshot.is_some()
                || wire.events.is_some()
                || wire.checkpoint.is_some()
            {
                return Err(malformed());
            }
            return Ok(Self::Unclaimed {
                needs_user: wire.needs_user.unwrap_or(false),
            });
        }
        let sequence = wire.sequence.ok_or_else(malformed)?;
        let snapshot = wire.snapshot.ok_or_else(malformed)?;
        let events = wire.events.ok_or_else(malformed)?;
        if wire.needs_user.is_some()
            || sequence <= 0
            || events.last().map(|event| event.sequence) != Some(sequence)
            || events
                .windows(2)
                .any(|pair| pair[0].sequence >= pair[1].sequence)
            || events.iter().any(|event| event.sequence <= 0)
            || wire.checkpoint.as_ref().is_some_and(|cp| {
                cp.session_id != format!("coordinator_{}", snapshot.plan.workflow_id)
            })
        {
            return Err(malformed());
        }
        Ok(Self::Claimed {
            sequence,
            snapshot: Box::new(snapshot),
            events,
            checkpoint: wire.checkpoint,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowDecisionActor {
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowDecisionAuthority {
    ImplementationDetail,
    NeedsUser,
}

/// 决策值只含 Provider 续接所需字段，不暴露任意外部 JSON；权限判断仍由 Host 执行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDecisionValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority: Option<WorkflowDecisionAuthority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDecisionResult {
    pub actor: WorkflowDecisionActor,
    pub kind: WorkflowDecisionKind,
    pub run_id: String,
    pub value: WorkflowDecisionValue,
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidWorkflow(message.into())
}

/// Storage 查询和写入回执共用完整解码，阻止脏数据库内容穿过 Host。
pub(crate) fn decode_snapshot(value: Value) -> StorageResult<WorkflowSnapshotDto> {
    serde_json::from_value(value)
        .map_err(|error| invalid(format!("invalid workflow snapshot: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Storage;
    use semi_os_protocol::validate_workflow_plan;
    use serde_json::json;

    fn stored_workflow() -> (Storage, WorkflowPlan, String) {
        let mut storage = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        storage
            .create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        storage.save_workflow_plan(&plan, &digest, 2).unwrap();
        (storage, plan, digest)
    }

    #[test]
    fn typed_mutation_and_claim_receipts_preserve_worker_wire_shape() {
        let (mut storage, plan, digest) = stored_workflow();
        let snapshot = storage
            .decide_workflow(&plan.workflow_id, 1, &digest, "approved", 3)
            .unwrap();
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            storage.load_workflow(&plan.workflow_id).unwrap().unwrap()
        );
        let claim = storage
            .claim_workflow(&plan.workflow_id, "owner", 4)
            .unwrap();
        let wire = serde_json::to_value(&claim).unwrap();
        assert_eq!(wire["claimed"], true);
        assert_eq!(wire["checkpoint"], Value::Null);
        let decoded: WorkflowClaimResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
        assert_eq!(
            serde_json::to_value(
                storage
                    .claim_workflow(&plan.workflow_id, "other", 5)
                    .unwrap()
            )
            .unwrap(),
            json!({"claimed":false})
        );
        assert_eq!(
            serde_json::to_value(
                storage
                    .workflow_decision_result(&plan.workflow_id, "missing")
                    .unwrap()
            )
            .unwrap(),
            Value::Null
        );
        for malformed in [
            json!({"claimed":true}),
            json!({"claimed":"true"}),
            json!({"claimed":false,"sequence":1}),
            json!({"claimed":false,"unexpected":true}),
        ] {
            assert!(serde_json::from_value::<WorkflowClaimResult>(malformed).is_err());
        }
        let mut malformed = wire.clone();
        malformed["sequence"] = json!(999);
        assert!(serde_json::from_value::<WorkflowClaimResult>(malformed).is_err());
        let mut malformed = wire;
        malformed["checkpoint"] = json!({"sessionId":"another_workflow","sequence":1,"data":{}});
        assert!(serde_json::from_value::<WorkflowClaimResult>(malformed).is_err());
    }

    #[test]
    fn corrupt_checkpoint_does_not_acquire_a_lease() {
        let (mut storage, plan, digest) = stored_workflow();
        let id = &plan.workflow_id;
        storage
            .decide_workflow(id, 1, &digest, "approved", 3)
            .unwrap();
        storage
            .connection
            .execute(
                "INSERT INTO workflow_coordinators(workflow_id,checkpoint_json) VALUES(?1,?2)",
                rusqlite::params![id, r#"{"sessionId":"wrong","sequence":1,"data":{}}"#],
            )
            .unwrap();
        assert!(storage.claim_workflow(id, "owner", 4).is_err());
        let owner: Option<String> = storage
            .connection
            .query_row(
                "SELECT owner FROM workflow_coordinators WHERE workflow_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(owner.is_none());
    }

    #[test]
    fn decision_receipts_reject_corrupt_provider_fields() {
        let receipt = json!({"actor":"agent","kind":"clarification","runId":"run_fixture",
            "value":{"authority":"implementation_detail","reason":"范围内细节","answers":{"格式":"JSON"}}});
        let dto: WorkflowDecisionResult = serde_json::from_value(receipt.clone()).unwrap();
        assert_eq!(serde_json::to_value(dto).unwrap(), receipt);
        for malformed in [
            json!({"actor":"external","kind":"plan","runId":"run","value":{"approved":true}}),
            json!({"actor":"agent","kind":"clarification","runId":"run","value":{"answers":{"格式":123}}}),
            json!({"actor":"agent","kind":"plan","runId":"run","value":{"authority":"elevated","approved":true}}),
            json!({"actor":"agent","kind":"plan","runId":"run","value":{"unexpected":true}}),
        ] {
            assert!(serde_json::from_value::<WorkflowDecisionResult>(malformed).is_err());
        }
    }

    #[test]
    fn typed_queries_preserve_stored_snapshot_and_notification_json() {
        let (storage, plan, _) = stored_workflow();
        let raw = storage.load_workflow(&plan.workflow_id).unwrap().unwrap();
        let snapshot = storage
            .load_workflow_dto(&plan.workflow_id)
            .unwrap()
            .unwrap();
        validate_workflow_plan(&snapshot.plan).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), raw);
        assert_eq!(
            serde_json::to_value(storage.load_workflows_dto(&plan.session_id).unwrap()).unwrap(),
            json!([raw])
        );
        assert_eq!(
            serde_json::to_value(
                storage
                    .find_workflows_dto(&plan.title, &plan.repository, "")
                    .unwrap()
            )
            .unwrap(),
            json!([raw])
        );
        assert_eq!(
            serde_json::to_value(
                storage
                    .workflow_notifications_dto(&plan.session_id)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(storage.workflow_notifications(&plan.session_id).unwrap())
                .unwrap()
        );
        assert!(storage.load_workflow_dto("missing").unwrap().is_none());
        assert!(storage
            .find_workflows_dto("missing", "", "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn typed_background_tracks_user_grant_and_intent_revocation() {
        let (mut storage, plan, digest) = stored_workflow();
        let id = &plan.workflow_id;
        assert!(storage.workflow_background_dto(id).unwrap().grant.is_none());
        storage
            .decide_workflow(id, 1, &digest, "approved", 3)
            .unwrap();
        let background = storage.workflow_background_dto(id).unwrap();
        let grant = background.grant.unwrap();
        assert_eq!(grant.actor, "user");
        assert_eq!(grant.intent_version, plan.intent_version);
        assert_eq!(grant.actions, plan.authorized_actions);
        assert_eq!(Some(grant), storage.workflow_grant_dto(id).unwrap());
        storage
            .change_workflow_intent(id, "改为只读评估", 4)
            .unwrap();
        assert!(storage.workflow_grant_dto(id).unwrap().is_none());
        assert!(storage.workflow_background_dto(id).unwrap().grant.is_none());
        assert_eq!(
            storage.load_workflow_dto(id).unwrap().unwrap().status,
            "needs_revision"
        );
    }

    #[test]
    fn typed_queries_reject_corrupt_event_instead_of_returning_partial_results() {
        let (mut storage, plan, _) = stored_workflow();
        storage
            .record_workflow_event(&plan.workflow_id, "run.updated", "测试事件", 3)
            .unwrap();
        storage
            .connection
            .execute(
                "UPDATE workflows SET consumed_sequence=0 WHERE workflow_id=?1",
                rusqlite::params![plan.workflow_id],
            )
            .unwrap();
        storage
            .connection
            .execute(
                "UPDATE workflow_events SET event_json=?1 WHERE workflow_id=?2",
                rusqlite::params![
                    json!({"eventId": "evt_bad", "kind": "run.updated", "sequence": "not-an-integer"}).to_string(),
                    plan.workflow_id
                ],
            )
            .unwrap();
        let error = storage.load_workflow_dto(&plan.workflow_id).unwrap_err();
        assert!(matches!(error, StorageError::InvalidWorkflow(_)));
        assert!(storage
            .workflow_notifications_dto(&plan.session_id)
            .is_err());
        assert!(storage.load_workflows_dto(&plan.session_id).is_err());
        assert!(storage.find_workflows_dto("", "", "").is_err());
        assert!(storage.workflow_recovery_snapshots_dto().is_err());
    }

    #[test]
    fn recovery_queries_preserve_all_sessions_and_fail_on_corrupt_session() {
        let (mut storage, mut plan, digest) = stored_workflow();
        plan.workflow_id = "wf_second".into();
        plan.session_id = "session_second".into();
        storage
            .create_client_session(&plan.session_id, "second", 4)
            .unwrap();
        storage.save_workflow_plan(&plan, &digest, 5).unwrap();
        let snapshots = storage.workflow_recovery_snapshots_dto().unwrap();
        assert_eq!(snapshots.len(), 2);
        assert!(snapshots
            .iter()
            .any(|snapshot| snapshot.plan.session_id == plan.session_id));
        storage
            .connection
            .execute(
                "UPDATE workflow_plans SET plan_json=?1 WHERE workflow_id=?2",
                rusqlite::params![
                    json!({"workflowId": plan.workflow_id}).to_string(),
                    plan.workflow_id
                ],
            )
            .unwrap();
        // 恢复必须整体失败，不能仅返回另一个完好的会话。
        assert!(storage.workflow_recovery_snapshots_dto().is_err());
    }

    #[test]
    fn decision_input_preserves_provider_questions_and_rejects_invalid_shapes() {
        let input = json!({"questions":[{
            "question":"选择哪些方案？","header":"方案","multiSelect":true,
            "options":[{"label":"A","description":"方案 A"}]
        }]});
        let parsed: WorkflowDecisionInput = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), input);
        for invalid in [
            json!({"unapproved":true}),
            json!({"questions":[{"question":1}]}),
            json!({"questions":[{"question":"选择？","multiSelect":"yes"}]}),
            json!({"questions":[{"question":"选择？","options":[{"label":"A"}]}]}),
        ] {
            assert!(serde_json::from_value::<WorkflowDecisionInput>(invalid).is_err());
        }
    }

    #[test]
    fn snapshot_dto_decodes_structured_decision_input() {
        let value = serde_json::json!({
            "plan": {
                "workflowId": "wf_1",
                "sessionId": "session_1",
                "version": 1,
                "intentVersion": 1,
                "title": "任务",
                "goal": "完成任务",
                "scope": ["读取"],
                "acceptance": ["通过测试"],
                "authorizedActions": ["read"],
                "repository": "/tmp/repo",
                "workItems": [{
                    "workItemId": "item_1",
                    "title": "调查",
                    "objective": "读取资料",
                    "role": "research",
                    "provider": "pi",
                    "dependencies": [],
                    "outputs": ["结论"],
                    "acceptance": ["有证据"]
                }]
            },
            "digest": format!("sha256:{}", "a".repeat(64)),
            "status": "approved",
            "runs": [],
            "events": [],
            "findings": [],
            "background": {
                "coordinator": {
                    "executionStatus": "running",
                    "lastActivityAtMs": 1,
                    "noProgress": 0,
                    "reason": null
                },
                "grant": null,
                "requests": [{
                    "requestId": "request_1",
                    "runId": "run_1",
                    "kind": "clarification",
                    "input": {"questions": [{"question": "选择哪种方案？"}]},
                    "status": "needs_user"
                }]
            }
        });

        let snapshot = decode_snapshot(value).unwrap();
        assert_eq!(
            snapshot.background.requests[0]
                .input
                .questions
                .as_ref()
                .unwrap()[0]
                .question,
            "选择哪种方案？"
        );
    }

    #[test]
    fn snapshot_dto_rejects_unknown_input_fields() {
        let (storage, plan, _) = stored_workflow();
        let mut value = storage.load_workflow(&plan.workflow_id).unwrap().unwrap();
        // 其他字段必须有效，否则测试可能只因 plan 解码失败而假通过。
        decode_snapshot(value.clone()).unwrap();
        value["background"]["requests"] = json!([{
            "requestId":"request_1", "runId":"run_1", "kind":"clarification",
            "input":{"unapproved":true}, "status":"needs_user"
        }]);
        let error = decode_snapshot(value).unwrap_err().to_string();
        assert!(error.contains("unknown field `unapproved`"), "{error}");
    }
}
