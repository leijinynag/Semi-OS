use crate::{
    PolicyDecision, ResultType, ToolAttemptStatus, ToolRiskLevel, VerificationRecord,
    VerificationStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTarget {
    pub kind: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBinding {
    pub approval_id: String,
    pub payload_digest: String,
    pub approved_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReference {
    pub artifact_id: String,
    pub kind: String,
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// 跨 Worker/Host 边界的工具执行回执。
///
/// `input_summary` 只能包含脱敏后的可读摘要，规范化原始输入通过摘要绑定。
/// `Succeeded` 同时要求 `ResultType::Success` 和明确通过的验证记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionReceipt {
    pub attempt_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub idempotency_key: String,
    pub attempt_number: i64,
    pub status: ToolAttemptStatus,
    pub risk_level: ToolRiskLevel,
    pub input_summary: String,
    pub input_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ToolTarget>,
    pub policy_decision: PolicyDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalBinding>,
    pub started_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_type: Option<ResultType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationRecord>,
    pub artifacts: Vec<ArtifactReference>,
}

impl ToolExecutionReceipt {
    pub fn is_verified_success(&self) -> bool {
        self.status == ToolAttemptStatus::Succeeded
            && self.result_type == Some(ResultType::Success)
            && self
                .verification
                .as_ref()
                .is_some_and(|record| record.status == VerificationStatus::Passed)
    }
}
