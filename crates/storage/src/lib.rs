//! Semi-OS 的 Rust 所有持久化边界。
//!
//! 正常读取使用当前快照，审计与崩溃恢复使用追加事件和 Checkpoint。Node Worker
//! 与 React 都不能直接打开 SQLite，必须经由后续 Host 的类型化命令访问本模块。

mod error;
mod migrations;
mod models;
mod outbound_rpc;
mod repository;
mod rpc;
mod workflow;
mod workflow_background;
mod workflow_dto;
mod workflow_queries;

pub use error::{StorageError, StorageResult};
pub use models::{
    AgentSessionCheckpoint, NewTaskEvent, TaskEvent, TaskSnapshot, ToolAttempt, ToolReplayDecision,
};
pub use outbound_rpc::{OutboundReceipt, OutboundStatus};
pub use repository::{validate_session_title, ClientSession, Storage};
pub use rpc::{RpcDispatchDecision, RpcReceipt, RpcReceiptStatus, RpcResult};
pub use semi_os_protocol::ToolAttemptStatus;
pub use workflow_dto::{
    WorkflowBackground, WorkflowCheckpoint, WorkflowClaimResult, WorkflowCoordinator,
    WorkflowDecisionActor, WorkflowDecisionAuthority, WorkflowDecisionInput, WorkflowDecisionKind,
    WorkflowDecisionRequest, WorkflowDecisionResult, WorkflowDecisionValue, WorkflowEventRecord,
    WorkflowGrant, WorkflowNotification, WorkflowQuestion, WorkflowQuestionOption,
    WorkflowSnapshotDto,
};
