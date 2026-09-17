use semi_os_protocol::{
    DomainEvent, DomainEventContext, DomainEventPayload, TaskId, TaskLifecycle, TaskRunId, TraceId,
    VerificationRecord, VerificationStatus,
};
use semi_os_storage::{NewTaskEvent, Storage, StorageError, TaskEvent, TaskSnapshot};
use std::sync::{Arc, Mutex};
use thiserror::Error;

/// 领域事件先持久化、后发布。订阅者只能观察已提交事实，不能看到最终回滚的状态。
#[derive(Clone, Default)]
pub struct DomainEventBus {
    subscribers: Arc<Mutex<Vec<DomainEventHandler>>>,
}

pub type DomainEventHandler = Arc<dyn Fn(&DomainEvent) + Send + Sync + 'static>;

impl DomainEventBus {
    pub fn subscribe(&self, handler: DomainEventHandler) {
        self.subscribers
            .lock()
            .expect("domain event subscriber lock poisoned")
            .push(handler);
    }

    fn publish(&self, event: &DomainEvent) {
        let subscribers = self
            .subscribers
            .lock()
            .expect("domain event subscriber lock poisoned")
            .clone();
        for subscriber in subscribers {
            subscriber(event);
        }
    }
}

#[derive(Debug, Error)]
pub enum TaskRuntimeError {
    #[error("illegal task lifecycle transition from {from:?} to {to:?}")]
    IllegalTransition {
        from: TaskLifecycle,
        to: TaskLifecycle,
    },
    #[error("completed state requires explicit positive verification")]
    CompletionRequiresVerification,
    #[error("verification must contain non-model evidence")]
    InvalidVerification,
    #[error("domain event context does not match the current task")]
    ContextMismatch,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// TaskRun 的纯生命周期规则。语音状态是独立事件，不参与这里的状态转换。
pub struct TaskStateMachine;

impl TaskStateMachine {
    pub fn can_transition(from: TaskLifecycle, to: TaskLifecycle) -> bool {
        use TaskLifecycle::{
            Cancelled, Completed, Created, Failed, Listening, NeedsUser, Paused, Reconciling,
            Running, Understanding, Unknown, Verifying, WaitingConfirmation,
        };

        matches!(
            (from, to),
            (Created, Listening | Understanding | Cancelled | Failed)
                | (Listening, Understanding | Cancelled | Failed)
                | (
                    Understanding,
                    Running | WaitingConfirmation | Cancelled | Failed
                )
                | (
                    Running,
                    Paused | WaitingConfirmation | Verifying | Unknown | Cancelled | Failed
                )
                | (Paused, Running | Cancelled | Failed)
                | (
                    WaitingConfirmation,
                    Running | NeedsUser | Cancelled | Failed
                )
                | (
                    Verifying,
                    Completed | Failed | Unknown | NeedsUser | Cancelled
                )
                | (Unknown, Reconciling | NeedsUser | Cancelled)
                | (Reconciling, Completed | Failed | NeedsUser | Cancelled)
                | (NeedsUser, Running | Reconciling | Cancelled | Failed)
        )
    }
}

/// Rust Host 内的任务权威入口。
///
/// 所有状态变化都在 SQLite 快照与追加事件的同一事务中提交。广播发生在事务
/// 成功后，因此 Worker 和 UI 可以把收到的事件视为可恢复的事实。
pub struct TaskRuntime {
    storage: Storage,
    event_bus: DomainEventBus,
}

impl TaskRuntime {
    pub fn new(storage: Storage, event_bus: DomainEventBus) -> Self {
        Self { storage, event_bus }
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub fn create(
        &mut self,
        snapshot: TaskSnapshot,
        event_id: impl Into<String>,
        source: impl Into<String>,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        if snapshot.lifecycle != TaskLifecycle::Created
            || snapshot.last_event_sequence != 0
            || self.storage.load_task(&snapshot.task_id)?.is_some()
        {
            return Err(TaskRuntimeError::IllegalTransition {
                from: snapshot.lifecycle,
                to: TaskLifecycle::Created,
            });
        }

        let event = DomainEvent {
            context: context_from_snapshot(&snapshot, event_id.into(), snapshot.created_at_ms),
            payload: DomainEventPayload::TaskLifecycleChanged {
                from: None,
                to: TaskLifecycle::Created,
                reason: Some(source.into()),
            },
        };
        self.persist(snapshot, event)
    }

    pub fn transition(
        &mut self,
        task_id: &str,
        to: TaskLifecycle,
        event_id: impl Into<String>,
        occurred_at_ms: i64,
        reason: Option<String>,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        if to == TaskLifecycle::Completed {
            return Err(TaskRuntimeError::CompletionRequiresVerification);
        }
        self.transition_internal(task_id, to, event_id, occurred_at_ms, reason)
    }

    pub fn complete_verified(
        &mut self,
        task_id: &str,
        event_id: impl Into<String>,
        occurred_at_ms: i64,
        verification: &VerificationRecord,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        validate_positive_verification(verification)?;
        self.transition_internal(
            task_id,
            TaskLifecycle::Completed,
            event_id,
            occurred_at_ms,
            Some(verification.summary.clone()),
        )
    }

    /// 非生命周期事件也复用同一任务序列，形成 UI、恢复和审计共享的有序流。
    pub fn record(
        &mut self,
        task_id: &str,
        event_id: impl Into<String>,
        occurred_at_ms: i64,
        payload: DomainEventPayload,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        let mut snapshot = self
            .storage
            .load_task(task_id)?
            .ok_or_else(|| StorageError::TaskNotFound(task_id.to_owned()))?;
        snapshot.updated_at_ms = occurred_at_ms;
        let event = DomainEvent {
            context: context_from_snapshot(&snapshot, event_id.into(), occurred_at_ms),
            payload,
        };
        self.persist(snapshot, event)
    }

    fn transition_internal(
        &mut self,
        task_id: &str,
        to: TaskLifecycle,
        event_id: impl Into<String>,
        occurred_at_ms: i64,
        reason: Option<String>,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        let mut snapshot = self
            .storage
            .load_task(task_id)?
            .ok_or_else(|| StorageError::TaskNotFound(task_id.to_owned()))?;
        let from = snapshot.lifecycle;
        if !TaskStateMachine::can_transition(from, to) {
            return Err(TaskRuntimeError::IllegalTransition { from, to });
        }

        snapshot.lifecycle = to;
        snapshot.updated_at_ms = occurred_at_ms;
        let event = DomainEvent {
            context: context_from_snapshot(&snapshot, event_id.into(), occurred_at_ms),
            payload: DomainEventPayload::TaskLifecycleChanged {
                from: Some(from),
                to,
                reason,
            },
        };
        self.persist(snapshot, event)
    }

    fn persist(
        &mut self,
        snapshot: TaskSnapshot,
        event: DomainEvent,
    ) -> Result<TaskEvent, TaskRuntimeError> {
        if event.context.task_id.0 != snapshot.task_id
            || event.context.task_run_id.0 != snapshot.task_run_id
            || event.context.trace_id.0 != snapshot.trace_id
        {
            return Err(TaskRuntimeError::ContextMismatch);
        }

        let stored = self.storage.persist_task_event(
            snapshot,
            NewTaskEvent {
                event_id: event.context.event_id.clone(),
                event_kind: event.kind().to_owned(),
                payload: serde_json::to_value(&event)?,
                occurred_at_ms: event.context.occurred_at_ms,
            },
        )?;
        self.event_bus.publish(&event);
        Ok(stored)
    }
}

fn context_from_snapshot(
    snapshot: &TaskSnapshot,
    event_id: String,
    occurred_at_ms: i64,
) -> DomainEventContext {
    DomainEventContext {
        event_id,
        task_id: TaskId(snapshot.task_id.clone()),
        task_run_id: TaskRunId(snapshot.task_run_id.clone()),
        trace_id: TraceId(snapshot.trace_id.clone()),
        occurred_at_ms,
    }
}

fn validate_positive_verification(
    verification: &VerificationRecord,
) -> Result<(), TaskRuntimeError> {
    if verification.status != VerificationStatus::Passed
        || verification.method == "model_prose"
        || verification.evidence.is_empty()
    {
        return Err(TaskRuntimeError::InvalidVerification);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_protocol::{EvidenceReference, ResultType};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn initial_task() -> TaskSnapshot {
        TaskSnapshot {
            task_id: "task_runtime".to_owned(),
            task_run_id: "run_runtime".to_owned(),
            trace_id: "trace_runtime".to_owned(),
            lifecycle: TaskLifecycle::Created,
            title: Some("测试任务".to_owned()),
            current_step: None,
            checkpoint: None,
            last_event_sequence: 0,
            created_at_ms: 100,
            updated_at_ms: 100,
        }
    }

    fn verification(method: &str) -> VerificationRecord {
        VerificationRecord {
            status: VerificationStatus::Passed,
            method: method.to_owned(),
            summary: "目标状态已读回".to_owned(),
            evidence: vec![EvidenceReference {
                kind: "state_readback".to_owned(),
                reference: "evidence_01".to_owned(),
            }],
            verified_at_ms: Some(400),
        }
    }

    #[test]
    fn persists_then_publishes_legal_transitions() {
        let bus = DomainEventBus::default();
        let published = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&published);
        bus.subscribe(Arc::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        }));
        let mut runtime =
            TaskRuntime::new(Storage::open_in_memory().expect("storage should open"), bus);

        runtime
            .create(initial_task(), "evt_created", "voice")
            .expect("task should be created");
        runtime
            .transition(
                "task_runtime",
                TaskLifecycle::Understanding,
                "evt_understanding",
                200,
                None,
            )
            .expect("task should transition");
        runtime
            .transition(
                "task_runtime",
                TaskLifecycle::Running,
                "evt_running",
                300,
                None,
            )
            .expect("task should transition");
        runtime
            .record(
                "task_runtime",
                "evt_progress",
                350,
                DomainEventPayload::TaskResultRecorded {
                    result_type: ResultType::Unknown,
                    summary: "尚未验证".to_owned(),
                },
            )
            .expect("structured event should persist");

        assert_eq!(published.load(Ordering::SeqCst), 4);
        assert_eq!(
            runtime
                .storage()
                .load_task_events("task_runtime")
                .expect("events should load")
                .len(),
            4
        );
    }

    #[test]
    fn rejects_illegal_and_unverified_completion() {
        let mut runtime = TaskRuntime::new(
            Storage::open_in_memory().expect("storage should open"),
            DomainEventBus::default(),
        );
        runtime
            .create(initial_task(), "evt_created", "voice")
            .expect("task should be created");
        assert!(matches!(
            runtime.transition(
                "task_runtime",
                TaskLifecycle::Completed,
                "evt_completed",
                200,
                None
            ),
            Err(TaskRuntimeError::CompletionRequiresVerification)
        ));
        assert!(matches!(
            runtime.transition(
                "task_runtime",
                TaskLifecycle::Paused,
                "evt_paused",
                200,
                None
            ),
            Err(TaskRuntimeError::IllegalTransition { .. })
        ));
    }

    #[test]
    fn model_prose_cannot_prove_completion() {
        let mut runtime = TaskRuntime::new(
            Storage::open_in_memory().expect("storage should open"),
            DomainEventBus::default(),
        );
        runtime
            .create(initial_task(), "evt_created", "voice")
            .expect("task should be created");
        runtime
            .transition(
                "task_runtime",
                TaskLifecycle::Understanding,
                "evt_understanding",
                200,
                None,
            )
            .expect("task should transition");
        runtime
            .transition(
                "task_runtime",
                TaskLifecycle::Running,
                "evt_running",
                250,
                None,
            )
            .expect("task should transition");
        runtime
            .transition(
                "task_runtime",
                TaskLifecycle::Verifying,
                "evt_verifying",
                300,
                None,
            )
            .expect("task should verify");

        assert!(matches!(
            runtime.complete_verified(
                "task_runtime",
                "evt_completed",
                400,
                &verification("model_prose")
            ),
            Err(TaskRuntimeError::InvalidVerification)
        ));
        runtime
            .complete_verified(
                "task_runtime",
                "evt_completed",
                400,
                &verification("state_readback"),
            )
            .expect("readback should prove completion");
    }

    #[test]
    fn unknown_requires_reconciliation_before_resolution() {
        assert!(TaskStateMachine::can_transition(
            TaskLifecycle::Running,
            TaskLifecycle::Unknown
        ));
        assert!(!TaskStateMachine::can_transition(
            TaskLifecycle::Unknown,
            TaskLifecycle::Running
        ));
        assert!(TaskStateMachine::can_transition(
            TaskLifecycle::Unknown,
            TaskLifecycle::Reconciling
        ));
    }
}
