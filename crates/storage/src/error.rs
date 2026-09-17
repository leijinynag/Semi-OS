use rusqlite::Error as SqliteError;
use thiserror::Error;

/// 存储层错误保留稳定语义，Host 不应依赖 SQLite 的具体错误字符串做控制流。
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite operation failed: {0}")]
    Sqlite(#[from] SqliteError),
    #[error("json serialization failed: {0}")]
    Json(#[from] serde_json::Error),
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
}

pub type StorageResult<T> = Result<T, StorageError>;
