//! Semi-OS Rust Host 的可测试核心。
//!
//! Tauri 只负责把本模块接到桌面窗口和系统事件；生命周期、Worker 监督和
//! 诊断持久化不能依赖 WebView，这样崩溃恢复逻辑可以在无界面的测试中验证。

mod diagnostics;
mod lifecycle;
mod supervisor;
mod task;

pub use diagnostics::{DiagnosticRecord, DiagnosticStore};
pub use lifecycle::{HostLifecycle, HostLifecycleSnapshot, HostPhase};
pub use supervisor::{
    RestartPolicy, WorkerCommand, WorkerEvent, WorkerEventHandler, WorkerMessageHandler,
    WorkerSupervisor, WorkerSupervisorHandle,
};
pub use task::{
    DomainEventBus, DomainEventHandler, TaskRuntime, TaskRuntimeError, TaskStateMachine,
};
