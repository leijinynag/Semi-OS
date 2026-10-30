//! Semi-OS Rust Host 的可测试核心。
//!
//! Tauri 只负责把本模块接到桌面窗口和系统事件；生命周期、Worker 监督和
//! 诊断持久化不能依赖 WebView，这样崩溃恢复逻辑可以在无界面的测试中验证。

pub mod conversation;
pub mod desktop;
pub mod desktop_router;
pub use semi_os_desktop_macos as desktop_macos;
mod diagnostics;
mod error;
mod lifecycle;
pub mod memory_controls;
mod outbound_rpc;
pub mod research;
pub mod research_router;
pub mod rpc;
mod supervisor;
mod task;
mod tool_execution;
pub mod voice;
pub mod workflow;
pub mod workflow_command;
pub mod workflow_policy;

pub use diagnostics::{DiagnosticRecord, DiagnosticStore};
pub use error::{HostError, HostResult};
pub use lifecycle::{
    route_lifecycle, HostLifecycle, HostLifecycleSnapshot, HostPhase, LifecycleCommand,
};
pub use supervisor::{
    RestartPolicy, WorkerCommand, WorkerEvent, WorkerEventHandler, WorkerMessageHandler,
    WorkerSupervisor, WorkerSupervisorHandle,
};
pub use task::{
    DomainEventBus, DomainEventHandler, TaskRuntime, TaskRuntimeError, TaskStateMachine,
};
pub use tool_execution::{
    decide_execution, save_execution_receipt, ToolExecutionDecision, ToolExecutionError,
};
pub use workflow_command::{
    WorkflowControlAction, WorkflowControlRequest, WorkflowQuestionAnswerRequest,
    WorkflowRequirementChangeRequest, WorkflowUserDecision, WorkflowUserDecisionRequest,
};
