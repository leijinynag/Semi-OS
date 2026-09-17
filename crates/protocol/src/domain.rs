use crate::{
    PolicyDecision, ResultType, TaskId, TaskLifecycle, TaskRunId, ToolAttemptStatus, TraceId,
    VerificationStatus, VoiceState, WorkerState,
};
use serde::{Deserialize, Serialize};

/// 每个领域事件都携带完整任务上下文，跨进程转发后仍可独立排序和追踪。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEventContext {
    pub event_id: String,
    pub task_id: TaskId,
    pub task_run_id: TaskRunId,
    pub trace_id: TraceId,
    pub occurred_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    pub kind: String,
    pub reference: String,
}

/// 验证记录只陈述可复查的观察结果，模型生成的自然语言不能充当验证证据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub status: VerificationStatus,
    pub method: String,
    pub summary: String,
    pub evidence: Vec<EvidenceReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at_ms: Option<i64>,
}

/// Rust Host、Node Worker 和 React UI 共用的稳定事件载荷。
///
/// 使用显式判别联合而不是任意 JSON，保证新增字段或事件类型时由编译器推动
/// 各边界同步升级。外层结构保持扁平，与 TypeScript 的 `DomainEvent` 同构。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DomainEvent {
    #[serde(flatten)]
    pub context: DomainEventContext,
    #[serde(flatten)]
    pub payload: DomainEventPayload,
}

impl DomainEvent {
    pub fn kind(&self) -> &'static str {
        self.payload.kind()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DomainEventPayload {
    #[serde(rename = "task.lifecycle_changed", rename_all = "camelCase")]
    TaskLifecycleChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<TaskLifecycle>,
        to: TaskLifecycle,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "task.progress_updated", rename_all = "camelCase")]
    TaskProgressUpdated {
        step: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        completed_units: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_units: Option<u64>,
    },
    #[serde(rename = "voice.state_changed", rename_all = "camelCase")]
    VoiceStateChanged { state: VoiceState },
    #[serde(rename = "tool.attempt_updated", rename_all = "camelCase")]
    ToolAttemptUpdated {
        attempt_id: String,
        tool_name: String,
        status: ToolAttemptStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_type: Option<ResultType>,
    },
    #[serde(rename = "approval.requested", rename_all = "camelCase")]
    ApprovalRequested {
        approval_id: String,
        attempt_id: String,
        action: String,
        payload_digest: String,
    },
    #[serde(rename = "approval.resolved", rename_all = "camelCase")]
    ApprovalResolved {
        approval_id: String,
        attempt_id: String,
        decision: PolicyDecision,
    },
    #[serde(rename = "worker.state_changed", rename_all = "camelCase")]
    WorkerStateChanged {
        state: WorkerState,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "verification.recorded", rename_all = "camelCase")]
    VerificationRecorded {
        attempt_id: String,
        verification: VerificationRecord,
    },
    #[serde(rename = "task.result_recorded", rename_all = "camelCase")]
    TaskResultRecorded {
        result_type: ResultType,
        summary: String,
    },
}

impl DomainEventPayload {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TaskLifecycleChanged { .. } => "task.lifecycle_changed",
            Self::TaskProgressUpdated { .. } => "task.progress_updated",
            Self::VoiceStateChanged { .. } => "voice.state_changed",
            Self::ToolAttemptUpdated { .. } => "tool.attempt_updated",
            Self::ApprovalRequested { .. } => "approval.requested",
            Self::ApprovalResolved { .. } => "approval.resolved",
            Self::WorkerStateChanged { .. } => "worker.state_changed",
            Self::VerificationRecorded { .. } => "verification.recorded",
            Self::TaskResultRecorded { .. } => "task.result_recorded",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_shared_domain_event_fixture() {
        let fixture = include_str!("../../../tests/contract/fixtures/domain-event.json");
        let event: DomainEvent =
            serde_json::from_str(fixture).expect("domain event fixture should deserialize");

        assert_eq!(event.kind(), "task.lifecycle_changed");
        assert!(matches!(
            event.payload,
            DomainEventPayload::TaskLifecycleChanged {
                from: Some(TaskLifecycle::Understanding),
                to: TaskLifecycle::Running,
                ..
            }
        ));
    }
}
