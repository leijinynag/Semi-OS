use semi_os_protocol::{ResultType, TaskLifecycle, ToolRiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `tasks` 表中的当前任务投影。
///
/// `last_event_sequence` 是乐观并发版本，也是快照与追加事件的一致性锚点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task_id: String,
    pub task_run_id: String,
    pub trace_id: String,
    pub lifecycle: TaskLifecycle,
    pub title: Option<String>,
    pub current_step: Option<String>,
    pub checkpoint: Option<Value>,
    pub last_event_sequence: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 待追加的领域事件；序号由存储事务分配，调用方不能自行跳号。
#[derive(Debug, Clone, PartialEq)]
pub struct NewTaskEvent {
    pub event_id: String,
    pub event_kind: String,
    pub payload: Value,
    pub occurred_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub event_id: String,
    pub task_id: String,
    pub sequence: i64,
    pub event_kind: String,
    pub payload: Value,
    pub projection: TaskSnapshot,
    pub occurred_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentSessionCheckpoint {
    pub session_id: String,
    pub task_id: Option<String>,
    pub runtime_kind: String,
    pub runtime_session_ref: Option<String>,
    pub checkpoint: Option<Value>,
    pub checkpoint_sequence: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAttemptStatus {
    Started,
    Succeeded,
    Failed,
    Unknown,
    Cancelled,
    NeedsUser,
}

impl ToolAttemptStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
            Self::Cancelled => "cancelled",
            Self::NeedsUser => "needs_user",
        }
    }

    pub(crate) fn parse(value: String) -> Option<Self> {
        match value.as_str() {
            "started" => Some(Self::Started),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "unknown" => Some(Self::Unknown),
            "cancelled" => Some(Self::Cancelled),
            "needs_user" => Some(Self::NeedsUser),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolAttempt {
    pub attempt_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub idempotency_key: String,
    pub attempt_number: i64,
    pub status: ToolAttemptStatus,
    pub risk_level: ToolRiskLevel,
    pub input_digest: String,
    pub target: Option<Value>,
    pub policy: Option<Value>,
    pub result_type: Option<ResultType>,
    pub receipt: Option<Value>,
    pub verification: Option<Value>,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}

/// Worker 恢复后必须先查询该决定，再决定是否可以调用真实工具。
#[derive(Debug, Clone, PartialEq)]
pub enum ToolReplayDecision {
    Execute,
    ReuseCompleted(ToolAttempt),
    ReconcileIncomplete(ToolAttempt),
}
