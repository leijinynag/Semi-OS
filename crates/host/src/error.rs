use semi_os_storage::StorageError;
use thiserror::Error;

/// Host 内部统一错误边界。
///
/// 业务模块可以保留详细的 `source` 供日志和测试使用，但 Tauri/WebView
/// 不应直接接收数据库、进程或第三方库的原始错误，避免把实现细节和敏感
/// 信息泄露到 UI。迁移期间旧入口仍可把它转换成 `String`。
#[derive(Debug, Error)]
pub enum HostError {
    #[error("storage is unavailable")]
    StorageUnavailable,
    #[error("worker is unavailable")]
    WorkerUnavailable,
    #[error("lifecycle state is unavailable")]
    LifecycleUnavailable,
    #[error("invalid host request: {0}")]
    InvalidRequest(String),
    #[error("invalid lifecycle transition: {from:?} -> {to:?}")]
    InvalidLifecycleTransition {
        from: crate::lifecycle::HostPhase,
        to: crate::lifecycle::HostPhase,
    },
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl HostError {
    /// 将内部错误压缩成稳定、不会泄露底层实现的 UI 文案。
    pub fn ui_message(&self) -> &'static str {
        match self {
            Self::Storage(StorageError::RpcConflict) => "请求标识已被不同操作使用，已拒绝执行",
            Self::Storage(StorageError::RpcReconciliation) => "执行结果不确定，需要先核对再继续",
            Self::StorageUnavailable | Self::Storage(_) => "本地存储暂不可用",
            Self::WorkerUnavailable => "后台 Agent 暂不可用",
            Self::LifecycleUnavailable => "Host 生命周期状态暂不可用",
            Self::InvalidRequest(_) => "请求无效，请重试",
            Self::InvalidLifecycleTransition { .. } => "Host 当前状态不允许此操作",
            Self::Json(_) => "数据格式无效",
        }
    }
}

pub type HostResult<T> = Result<T, HostError>;
