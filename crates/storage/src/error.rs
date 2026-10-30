use rusqlite::Error as SqliteError;
use thiserror::Error;

/// 存储层错误保留稳定语义，Host 不应依赖 SQLite 的具体错误字符串做控制流。
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("rpc request identity conflicts with an existing receipt")]
    RpcConflict,
    #[error("rpc result requires reconciliation before dispatch")]
    RpcReconciliation,
    #[error("desktop action transition rejected")]
    InvalidDesktopTransition,
    #[error("workflow rejected: {0}")]
    InvalidWorkflow(String),
    #[error("sqlite operation failed: {0}")]
    Sqlite(#[from] SqliteError),
    #[error("json serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("会话名称不能为空，不能超过 80 字符或包含控制字符")]
    InvalidSessionTitle,
    #[error("必须先切换会话再删除当前会话")]
    ActiveSessionDeletion,
    #[error("task not found: {0}")]
    TaskNotFound(String),
    #[error("task event sequence conflict for {task_id}: expected {expected}, current {actual}")]
    EventSequenceConflict {
        task_id: String,
        expected: i64,
        actual: i64,
    },
    #[error("event stream is invalid for task {task_id}: {reason}")]
    InvalidEventStream { task_id: String, reason: String },
    #[error("invalid persisted enum {kind}: {value}")]
    InvalidEnum { kind: &'static str, value: String },
    #[error("找不到记忆：{0}")]
    MemoryNotFound(String),
    #[error("记忆记录无效：{0}")]
    InvalidMemory(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
