//! 对话内执行视图的只读投影；复用 TaskRun、事件与回执，不创建第二套状态机。
use crate::{Storage, StorageResult};
use semi_os_protocol::{TaskLifecycle, ToolExecutionReceipt};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProgress {
    pub sequence: i64,
    pub call_id: String,
    pub tool_name: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshot {
    pub task_id: String,
    pub lifecycle: Option<TaskLifecycle>,
    pub progress: Vec<ExecutionProgress>,
    pub receipts: Vec<ToolExecutionReceipt>,
    pub sources: Vec<serde_json::Value>,
}

impl Storage {
    /// 工具型任务即使没有来源/报告也能恢复。缺少回执不能推断为成功。
    pub fn load_execution_snapshot(&self, task: &str) -> StorageResult<ExecutionSnapshot> {
        let lifecycle = self.load_task(task)?.map(|snapshot| snapshot.lifecycle);
        let progress = self
            .load_task_events(task)?
            .into_iter()
            .filter(|event| event.event_kind == "research.progress")
            .map(|event| {
                // 持久事件仍需解码校验；损坏记录不得静默跳过。
                let payload: semi_os_protocol::messages::EventResearchProgressPayload =
                    serde_json::from_value(event.payload)?;
                Ok(ExecutionProgress {
                    sequence: event.sequence,
                    call_id: payload.call_id,
                    tool_name: payload.tool_name,
                    label: payload.label,
                })
            })
            .collect::<StorageResult<Vec<_>>>()?;
        let receipts = self
            .load_task_attempts(task)?
            .into_iter()
            .filter_map(|attempt| attempt.receipt)
            .map(serde_json::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        let sources = self.load_research_report_sources(task)?;
        let cited_source_ids = self
            .load_research_report(task)?
            .map(|report| {
                report
                    .get("claims")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .flat_map(|claim| {
                        claim
                            .get("citations")
                            .and_then(serde_json::Value::as_array)
                            .into_iter()
                            .flatten()
                    })
                    .filter_map(|citation| {
                        citation.get("sourceId").and_then(serde_json::Value::as_str)
                    })
                    .map(str::to_owned)
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        // 同会话旧来源只有在当前报告明确引用时才进入执行视图；否则普通聊天
        // 不能因为复用会话而显示上一轮调研材料。
        let sources = sources
            .into_iter()
            .filter(|source| {
                source.get("taskId").and_then(serde_json::Value::as_str) == Some(task)
                    || source
                        .get("sourceId")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|source_id| cited_source_ids.contains(source_id))
            })
            .collect();
        Ok(ExecutionSnapshot {
            task_id: task.into(),
            lifecycle,
            progress,
            receipts,
            sources,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NewTaskEvent, TaskSnapshot};

    #[test]
    fn restores_tool_only_progress_and_rejects_corrupt_events() {
        let mut storage = Storage::open_in_memory().unwrap();
        assert!(storage
            .load_execution_snapshot("task_chat")
            .unwrap()
            .lifecycle
            .is_none());
        let snapshot = TaskSnapshot {
            task_id: "task_tools".into(),
            task_run_id: "run_tools".into(),
            trace_id: "trace_tools".into(),
            lifecycle: TaskLifecycle::Running,
            title: None,
            current_step: None,
            checkpoint: None,
            last_event_sequence: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        storage.persist_task_event(snapshot, NewTaskEvent {
            event_id: "evt_tools".into(), event_kind: "research.progress".into(),
            payload: serde_json::json!({"taskId":"task_tools","toolName":"bash","callId":"call_1","label":"执行工具"}),
            occurred_at_ms: 1,
        }).unwrap();
        let restored = storage.load_execution_snapshot("task_tools").unwrap();
        assert_eq!(restored.progress[0].call_id, "call_1");
        assert!(restored.receipts.is_empty());
        storage
            .connection
            .execute(
                "UPDATE task_events SET payload_json='{}' WHERE task_id='task_tools'",
                [],
            )
            .unwrap();
        assert!(storage.load_execution_snapshot("task_tools").is_err());
    }

    #[test]
    fn execution_sources_only_include_current_or_report_cited_history() {
        let mut storage = Storage::open_in_memory().unwrap();
        let task = TaskSnapshot {
            task_id: "task_current".into(),
            task_run_id: "run_current".into(),
            trace_id: "trace_current".into(),
            lifecycle: TaskLifecycle::Completed,
            title: None,
            current_step: None,
            checkpoint: None,
            last_event_sequence: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        storage
            .persist_task_event(
                TaskSnapshot {
                    task_id: "task_old".into(),
                    task_run_id: "run_old".into(),
                    ..task.clone()
                },
                NewTaskEvent {
                    event_id: "evt_old".into(),
                    event_kind: "task.completed".into(),
                    payload: serde_json::json!({}),
                    occurred_at_ms: 1,
                },
            )
            .unwrap();
        storage
            .persist_task_event(
                task,
                NewTaskEvent {
                    event_id: "evt_current".into(),
                    event_kind: "task.completed".into(),
                    payload: serde_json::json!({}),
                    occurred_at_ms: 1,
                },
            )
            .unwrap();
        for task_id in ["task_old", "task_current"] {
            storage
                .save_conversation(
                    task_id,
                    &serde_json::json!({"sessionId":"session_default","taskId":task_id}),
                    1,
                )
                .unwrap();
        }
        let source = |source_id: &str, task_id: &str| {
            serde_json::json!({
                "sourceId": source_id,
                "taskId": task_id,
                "title": source_id,
                "finalUrl": format!("https://example.com/{source_id}"),
                "status": "collected",
                "collectedAtMs": 1,
            })
        };
        storage
            .save_research_source(&source("old", "task_old"))
            .unwrap();
        storage
            .save_research_source(&source("current", "task_current"))
            .unwrap();

        let without_report = storage
            .load_execution_snapshot("task_current")
            .unwrap()
            .sources;
        assert_eq!(
            without_report
                .iter()
                .filter_map(|item| item.get("sourceId").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>(),
            vec!["current"]
        );

        storage
            .save_research_report(
                "task_current",
                &serde_json::json!({
                    "claims": [{
                        "citations": [{"sourceId": "old", "quoteId": "q1"}]
                    }]
                }),
            )
            .unwrap();
        let with_report = storage
            .load_execution_snapshot("task_current")
            .unwrap()
            .sources;
        assert_eq!(
            with_report
                .iter()
                .filter_map(|item| item.get("sourceId").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>(),
            vec!["current", "old"]
        );
    }
}
