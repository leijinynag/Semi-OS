use semi_os_storage::WorkflowDecisionValue;
use serde::Deserialize;

/// 工作流真人入口的批准结果。
///
/// 使用枚举而不是任意字符串，避免客户端拼错状态后进入 Storage。
/// `as_storage_value` 保留既有数据库状态机使用的 wire value。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowUserDecision {
    Approved,
    Rejected,
    NeedsRevision,
}

impl WorkflowUserDecision {
    pub fn as_storage_value(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::NeedsRevision => "needs_revision",
        }
    }
}

/// 用户可执行的工作流控制动作。
///
/// 状态机仍由 Storage 校验当前快照和计划版本；这里先在 IPC 边界
/// 拒绝未知动作，避免任意字符串继续穿过 Host。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowControlAction {
    Pause,
    Resume,
    Cancel,
    ReconcileApplication,
    ResumeCoordinator,
}

impl WorkflowControlAction {
    pub fn as_storage_value(self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Cancel => "cancel",
            Self::ReconcileApplication => "reconcile_application",
            Self::ResumeCoordinator => "resume_coordinator",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowUserDecisionRequest {
    pub workflow_id: String,
    pub version: u32,
    pub digest: String,
    pub decision: WorkflowUserDecision,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowControlRequest {
    pub workflow_id: String,
    pub version: u32,
    pub digest: String,
    pub action: WorkflowControlAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRequirementChangeRequest {
    pub workflow_id: String,
    pub version: u32,
    pub digest: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowQuestionAnswerRequest {
    pub workflow_id: String,
    pub request_id: String,
    pub answer: WorkflowDecisionValue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_user_control_actions() {
        assert!(serde_json::from_value::<WorkflowControlAction>(json!("restart")).is_err());
    }

    #[test]
    fn keeps_existing_workflow_wire_values() {
        let request: WorkflowUserDecisionRequest = serde_json::from_value(json!({
            "workflowId": "wf_1",
            "version": 2,
            "digest": "sha256:abc",
            "decision": "needs_revision",
            "reason": "缩小范围"
        }))
        .unwrap();
        assert_eq!(request.decision.as_storage_value(), "needs_revision");
    }
}
