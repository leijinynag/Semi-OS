use crate::{
    AgentSessionCheckpoint, NewTaskEvent, StorageError, StorageResult, TaskEvent, TaskSnapshot,
    ToolAttempt, ToolAttemptStatus, ToolReplayDecision,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{path::Path, time::Duration};

pub struct Storage {
    pub(crate) connection: Connection,
}

/// 客户端 Session 独立于单轮 request/task；空会话也必须可在重启后恢复。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSession {
    pub session_id: String,
    pub title: String,
    pub created_at_ms: i64,
    pub active: bool,
}

/// 与前端按 UTF-16 单元统一限制；存储边界校验，不能信任 WebView 的输入框。
pub fn validate_session_title(title: &str) -> StorageResult<String> {
    let title = title.trim();
    if title.is_empty() || title.encode_utf16().count() > 80 || title.chars().any(char::is_control)
    {
        return Err(StorageError::InvalidSessionTitle);
    }
    Ok(title.to_owned())
}

impl Storage {
    pub fn load_client_sessions(&self) -> StorageResult<Vec<ClientSession>> {
        let mut statement = self.connection.prepare(
            "SELECT session_id,title,created_at_ms,active FROM client_sessions ORDER BY created_at_ms DESC, rowid DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ClientSession {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at_ms: row.get(2)?,
                active: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn create_client_session(&mut self, id: &str, title: &str, now: i64) -> StorageResult<()> {
        let title = validate_session_title(title)?;
        self.connection.execute(
            "INSERT INTO client_sessions(session_id,title,created_at_ms) VALUES(?1,?2,?3)",
            params![id, title, now],
        )?;
        Ok(())
    }

    pub fn rename_client_session(&mut self, id: &str, title: &str) -> StorageResult<()> {
        let title = validate_session_title(title)?;
        if self.connection.execute(
            "UPDATE client_sessions SET title=?1 WHERE session_id=?2",
            params![title, id],
        )? == 0
        {
            return Err(StorageError::SessionNotFound(id.into()));
        }
        Ok(())
    }

    /// 仅删除聊天归档；独立任务回执/证据仍保留，不将会话管理变成证据清理接口。
    pub fn delete_client_session(&mut self, id: &str) -> StorageResult<()> {
        self.ensure_session_has_no_live_workflow(id)?;
        let transaction = self.connection.transaction()?;
        let active: bool = transaction
            .query_row(
                "SELECT active FROM client_sessions WHERE session_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::SessionNotFound(id.into()))?;
        if active {
            return Err(StorageError::ActiveSessionDeletion);
        }
        transaction.execute("DELETE FROM conversation_turns WHERE session_id=?1", [id])?;
        transaction.execute("DELETE FROM client_sessions WHERE session_id=?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    /// 切换与唯一 active 标记在一个事务内完成；不存在的会话不得清掉当前选择。
    pub fn activate_client_session(&mut self, id: &str) -> StorageResult<()> {
        self.activate_and_delete_client_session(id, None)
    }

    /// 当前会话删除和后继选择必须原子提交，失败时不能留下零个 active。
    pub fn activate_and_delete_client_session(
        &mut self,
        id: &str,
        deleting: Option<&str>,
    ) -> StorageResult<()> {
        if let Some(deleting) = deleting {
            self.ensure_session_has_no_live_workflow(deleting)?;
        }
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM client_sessions WHERE session_id=?1)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::SessionNotFound(id.into()));
        }
        if let Some(deleting) = deleting {
            if deleting == id {
                return Err(StorageError::ActiveSessionDeletion);
            }
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM client_sessions WHERE session_id=?1)",
                [deleting],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::SessionNotFound(deleting.into()));
            }
        }
        transaction.execute("UPDATE client_sessions SET active=0 WHERE active=1", [])?;
        transaction.execute(
            "UPDATE client_sessions SET active=1 WHERE session_id=?1",
            [id],
        )?;
        if let Some(deleting) = deleting {
            transaction.execute(
                "DELETE FROM conversation_turns WHERE session_id=?1",
                [deleting],
            )?;
            transaction.execute(
                "DELETE FROM client_sessions WHERE session_id=?1",
                [deleting],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// 先结束或取消协作再删除 Session，避免后台工作失去用户监督与授权入口。
    fn ensure_session_has_no_live_workflow(&self, session: &str) -> StorageResult<()> {
        if self
            .load_workflows_dto(session)?
            .iter()
            .any(|workflow| !matches!(workflow.status.as_str(), "cancelled" | "rejected"))
        {
            return Err(StorageError::InvalidWorkflow(
                "请先取消此会话的协作工作流再删除会话".into(),
            ));
        }
        Ok(())
    }

    /// 只保存最终转写/回答及终态；播放位置和音量不写数据库。
    pub fn save_conversation(
        &mut self,
        request_id: &str,
        value: &Value,
        now: i64,
    ) -> StorageResult<()> {
        // 新记录使用 Host 当前身份；兼容旧调用方时归入默认会话，不影响历史迁移映射。
        let session_id = value["sessionId"].as_str().unwrap_or("session_default");
        self.connection.execute(
            "INSERT INTO conversation_turns(request_id,conversation_json,updated_at_ms,session_id) VALUES(?1,?2,?3,?4)
             ON CONFLICT(request_id) DO UPDATE SET conversation_json=excluded.conversation_json,updated_at_ms=excluded.updated_at_ms",
            params![request_id, serde_json::to_string(value)?, now, session_id],
        )?;
        Ok(())
    }

    pub fn load_conversations(&self) -> StorageResult<Vec<Value>> {
        let mut statement = self.connection.prepare(
            "SELECT conversation_json,session_id FROM conversation_turns ORDER BY updated_at_ms DESC LIMIT 200",
        )?;
        // UI 使用归档所属 Session，不因旧进程的运行 sessionId 拆分默认历史。
        let rows = statement.query_map([], |row| {
            let mut value: Value = decode_json(row.get(0)?)?;
            value["sessionId"] = Value::String(row.get(1)?);
            Ok(value)
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 重开客户端时从持久化证据恢复档案，不依赖本次窗口收到的内存事件。
    pub fn load_research_archive(&self) -> StorageResult<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT task_id FROM research_sources ORDER BY task_id")?;
        let tasks = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        tasks
            .into_iter()
            .map(|task| {
                let steps: Vec<String> = self.load_task_events(&task)?.into_iter()
                    .filter(|event| event.event_kind == "research.progress")
                    .filter_map(|event| event.payload["label"].as_str().map(str::to_owned))
                    .collect();
                Ok(serde_json::json!({
                    "id":task, "label":steps.last().map(String::as_str).unwrap_or("资料调研"), "steps":steps,
                    "sources":self.load_research_sources(&task)?,
                    "report":self.load_research_report(&task)?
                }))
            })
            .collect()
    }
    pub fn save_research_approval(
        &mut self,
        id: &str,
        task: &str,
        tool: &str,
        digest: &str,
        approved: bool,
        time: i64,
    ) -> StorageResult<()> {
        self.connection.execute("INSERT INTO approvals(approval_id,task_id,action,target_json,payload_digest,decision,requested_at_ms,decided_at_ms) VALUES(?1,?2,?3,'{}',?4,?5,?6,?6)",
            params![id, task, tool, digest, if approved { "approved" } else { "rejected" }, time])?;
        Ok(())
    }
    pub fn validates_research_approval(
        &self,
        id: &str,
        task: &str,
        tool: &str,
        digest: &str,
    ) -> StorageResult<bool> {
        self.connection.query_row("SELECT EXISTS(SELECT 1 FROM approvals WHERE approval_id=?1 AND task_id=?2 AND action=?3 AND payload_digest=?4 AND decision='approved' AND attempt_id IS NULL)",
            params![id,task,tool,digest], |row| row.get(0)).map_err(Into::into)
    }
    pub fn consume_research_approval(&mut self, id: &str, attempt: &str) -> StorageResult<()> {
        self.connection.execute(
            "UPDATE approvals SET attempt_id=?2 WHERE approval_id=?1 AND attempt_id IS NULL",
            params![id, attempt],
        )?;
        Ok(())
    }
    /// 来源与正文 Artifact 同事务保存；正文不重复塞进来源 JSON。
    pub fn save_research_source(&mut self, source: &Value) -> StorageResult<()> {
        let transaction = self.connection.transaction()?;
        let field = |name: &str| source.get(name).and_then(Value::as_str).unwrap_or("");
        let mut metadata = source.clone();
        metadata
            .as_object_mut()
            .expect("validated source object")
            .remove("text");
        if let Some(text) = source.get("text").and_then(Value::as_str) {
            transaction.execute(
                "INSERT INTO artifacts(artifact_id,task_id,kind,uri,media_type,digest,created_at_ms,content_text)
                 VALUES(?1,?2,'research_body',?3,'text/plain',?4,?5,?6)",
                params![field("artifactId"),field("taskId"),format!("artifact:{}",field("artifactId")),
                    field("digest"),source["collectedAtMs"].as_i64().unwrap_or(0),text],
            )?;
        }
        transaction.execute(
            "INSERT INTO research_sources(source_id,task_id,artifact_id,source_json,collected_at_ms) VALUES(?1,?2,?3,?4,?5)",
            params![field("sourceId"),field("taskId"),source.get("artifactId").and_then(Value::as_str),
                serde_json::to_string(&metadata)?,source["collectedAtMs"].as_i64().unwrap_or(0)],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_research_sources(&self, task_id: &str) -> StorageResult<Vec<Value>> {
        let mut statement = self.connection.prepare(
            "SELECT source_json FROM research_sources WHERE task_id=?1 ORDER BY collected_at_ms,source_id",
        )?;
        let rows = statement.query_map([task_id], |row| decode_json(row.get(0)?))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn load_artifact_text(
        &self,
        task_id: &str,
        artifact_id: &str,
    ) -> StorageResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT content_text FROM artifacts WHERE task_id=?1 AND artifact_id=?2",
                params![task_id, artifact_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_research_report(&mut self, task_id: &str, report: &Value) -> StorageResult<()> {
        self.connection.execute(
            "INSERT INTO research_reports(task_id,report_json) VALUES(?1,?2)
             ON CONFLICT(task_id) DO UPDATE SET report_json=excluded.report_json",
            params![task_id, serde_json::to_string(report)?],
        )?;
        Ok(())
    }

    pub fn load_research_report(&self, task_id: &str) -> StorageResult<Option<Value>> {
        self.connection
            .query_row(
                "SELECT report_json FROM research_reports WHERE task_id=?1",
                [task_id],
                |row| decode_json(row.get(0)?),
            )
            .optional()
            .map_err(Into::into)
    }
    /// 打开 Rust Host 独占的数据库连接并执行迁移。
    ///
    /// WAL 允许未来 UI 只读查询与 Host 写入并行；busy timeout 用于吸收本地短事务
    /// 竞争，但业务层仍需处理真正的写入冲突。
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> StorageResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut connection: Connection) -> StorageResult<Self> {
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        // 内存库会保留 `memory` journal，文件库切换为 WAL；两者共用初始化路径，
        // 让测试覆盖与生产一致的 PRAGMA 调用和 Migration 顺序。
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        crate::migrations::migrate(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn schema_version(&self) -> StorageResult<i64> {
        crate::migrations::current_version(&self.connection)
    }

    pub fn load_task(&self, task_id: &str) -> StorageResult<Option<TaskSnapshot>> {
        self.connection
            .query_row(
                "SELECT task_id, task_run_id, trace_id, lifecycle, title, current_step,
                        checkpoint_json, last_event_sequence, created_at_ms, updated_at_ms
                 FROM tasks WHERE task_id = ?1",
                [task_id],
                task_snapshot_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 将快照与事件放在同一个 `IMMEDIATE` 事务中提交。
    ///
    /// 调用方传入的 `last_event_sequence` 表示它基于哪个版本生成新投影。若数据库
    /// 已被另一条执行路径推进，事务会返回冲突而不是覆盖新状态。
    pub fn persist_task_event(
        &mut self,
        mut snapshot: TaskSnapshot,
        event: NewTaskEvent,
    ) -> StorageResult<TaskEvent> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current_sequence = current_task_sequence(&transaction, &snapshot.task_id)?;

        match current_sequence {
            Some(actual) if actual != snapshot.last_event_sequence => {
                return Err(StorageError::EventSequenceConflict {
                    task_id: snapshot.task_id,
                    expected: snapshot.last_event_sequence,
                    actual,
                });
            }
            None if snapshot.last_event_sequence != 0 => {
                return Err(StorageError::EventSequenceConflict {
                    task_id: snapshot.task_id,
                    expected: snapshot.last_event_sequence,
                    actual: 0,
                });
            }
            _ => {}
        }

        let next_sequence = snapshot.last_event_sequence + 1;
        snapshot.last_event_sequence = next_sequence;
        upsert_task(&transaction, &snapshot)?;

        let payload_json = serde_json::to_string(&event.payload)?;
        let projection_json = serde_json::to_string(&snapshot)?;
        transaction.execute(
            "INSERT INTO task_events(
                event_id, task_id, sequence, event_kind, payload_json,
                projection_json, occurred_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.event_id,
                snapshot.task_id,
                next_sequence,
                event.event_kind,
                payload_json,
                projection_json,
                event.occurred_at_ms
            ],
        )?;
        transaction.commit()?;

        Ok(TaskEvent {
            event_id: event.event_id,
            task_id: snapshot.task_id.clone(),
            sequence: next_sequence,
            event_kind: event.event_kind,
            payload: event.payload,
            projection: snapshot,
            occurred_at_ms: event.occurred_at_ms,
        })
    }

    pub fn load_task_events(&self, task_id: &str) -> StorageResult<Vec<TaskEvent>> {
        let mut statement = self.connection.prepare(
            "SELECT event_id, task_id, sequence, event_kind, payload_json,
                    projection_json, occurred_at_ms
             FROM task_events WHERE task_id = ?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([task_id], task_event_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    /// 从追加事件重建投影，并检查事件流是否连续且没有串入其他任务。
    pub fn replay_task(&self, task_id: &str) -> StorageResult<TaskSnapshot> {
        let events = self.load_task_events(task_id)?;
        if events.is_empty() {
            return Err(StorageError::TaskNotFound(task_id.to_owned()));
        }

        for (index, event) in events.iter().enumerate() {
            let expected_sequence = index as i64 + 1;
            if event.sequence != expected_sequence {
                return Err(StorageError::InvalidEventStream {
                    task_id: task_id.to_owned(),
                    reason: format!(
                        "expected sequence {expected_sequence}, found {}",
                        event.sequence
                    ),
                });
            }
            if event.task_id != task_id || event.projection.task_id != task_id {
                return Err(StorageError::InvalidEventStream {
                    task_id: task_id.to_owned(),
                    reason: format!("event {} belongs to another task", event.event_id),
                });
            }
            if event.projection.last_event_sequence != event.sequence {
                return Err(StorageError::InvalidEventStream {
                    task_id: task_id.to_owned(),
                    reason: format!(
                        "projection sequence {} does not match event sequence {}",
                        event.projection.last_event_sequence, event.sequence
                    ),
                });
            }
        }

        Ok(events
            .last()
            .expect("non-empty event stream checked above")
            .projection
            .clone())
    }

    pub fn save_agent_checkpoint(
        &mut self,
        checkpoint: &AgentSessionCheckpoint,
    ) -> StorageResult<()> {
        let checkpoint_json = encode_optional_json(checkpoint.checkpoint.as_ref())?;
        self.connection.execute(
            "INSERT INTO agent_sessions(
                session_id, task_id, runtime_kind, runtime_session_ref, checkpoint_json,
                checkpoint_sequence, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id) DO UPDATE SET
                task_id = excluded.task_id,
                runtime_kind = excluded.runtime_kind,
                runtime_session_ref = excluded.runtime_session_ref,
                checkpoint_json = excluded.checkpoint_json,
                checkpoint_sequence = excluded.checkpoint_sequence,
                updated_at_ms = excluded.updated_at_ms",
            params![
                checkpoint.session_id,
                checkpoint.task_id,
                checkpoint.runtime_kind,
                checkpoint.runtime_session_ref,
                checkpoint_json,
                checkpoint.checkpoint_sequence,
                checkpoint.created_at_ms,
                checkpoint.updated_at_ms
            ],
        )?;
        Ok(())
    }

    pub fn load_agent_checkpoint(
        &self,
        session_id: &str,
    ) -> StorageResult<Option<AgentSessionCheckpoint>> {
        self.connection
            .query_row(
                "SELECT session_id, task_id, runtime_kind, runtime_session_ref,
                        checkpoint_json, checkpoint_sequence, created_at_ms, updated_at_ms
                 FROM agent_sessions WHERE session_id = ?1",
                [session_id],
                |row| {
                    Ok(AgentSessionCheckpoint {
                        session_id: row.get(0)?,
                        task_id: row.get(1)?,
                        runtime_kind: row.get(2)?,
                        runtime_session_ref: row.get(3)?,
                        checkpoint: decode_optional_json(row.get(4)?)?,
                        checkpoint_sequence: row.get(5)?,
                        created_at_ms: row.get(6)?,
                        updated_at_ms: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn save_tool_attempt(&mut self, attempt: &ToolAttempt) -> StorageResult<()> {
        self.connection.execute(
            "INSERT INTO tool_attempts(
                attempt_id, task_id, tool_name, idempotency_key, attempt_number,
                status, risk_level, input_digest, target_json, policy_json,
                result_type, receipt_json, verification_json, started_at_ms, finished_at_ms
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
             )
             ON CONFLICT(attempt_id) DO UPDATE SET
                status = excluded.status,
                result_type = excluded.result_type,
                receipt_json = excluded.receipt_json,
                verification_json = excluded.verification_json,
                finished_at_ms = excluded.finished_at_ms",
            params![
                attempt.attempt_id,
                attempt.task_id,
                attempt.tool_name,
                attempt.idempotency_key,
                attempt.attempt_number,
                tool_attempt_status_as_str(attempt.status),
                encode_enum(attempt.risk_level)?,
                attempt.input_digest,
                encode_optional_json(attempt.target.as_ref())?,
                encode_optional_json(attempt.policy.as_ref())?,
                encode_optional_enum(attempt.result_type)?,
                encode_optional_json(attempt.receipt.as_ref())?,
                encode_optional_json(attempt.verification.as_ref())?,
                attempt.started_at_ms,
                attempt.finished_at_ms
            ],
        )?;
        Ok(())
    }

    /// 根据幂等键决定恢复动作，避免 Worker 重启后重复执行已完成的副作用。
    ///
    pub fn load_task_attempts(&self, task_id: &str) -> StorageResult<Vec<ToolAttempt>> {
        let mut statement = self.connection.prepare(&format!(
            "{} WHERE task_id=?1 ORDER BY started_at_ms,attempt_id",
            TOOL_ATTEMPT_SELECT
        ))?;
        let rows = statement.query_map([task_id], tool_attempt_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `started`、`unknown`、`needs_user` 没有确定终态，不能直接重试；上层必须
    /// 先通过工具专属读回或远端查询完成对账。明确失败或取消的尝试已经结束，
    /// 可以由上层策略决定是否创建下一次尝试。
    pub fn tool_replay_decision(
        &self,
        task_id: &str,
        idempotency_key: &str,
    ) -> StorageResult<ToolReplayDecision> {
        let completed = self
            .connection
            .query_row(
                &format!(
                    "{} WHERE task_id = ?1 AND idempotency_key = ?2
                     AND status = 'succeeded'
                     ORDER BY attempt_number DESC LIMIT 1",
                    TOOL_ATTEMPT_SELECT
                ),
                params![task_id, idempotency_key],
                tool_attempt_from_row,
            )
            .optional()?;
        if let Some(attempt) = completed {
            return Ok(ToolReplayDecision::ReuseCompleted(attempt));
        }

        let latest = self
            .connection
            .query_row(
                &format!(
                    "{} WHERE task_id = ?1 AND idempotency_key = ?2
                     ORDER BY attempt_number DESC LIMIT 1",
                    TOOL_ATTEMPT_SELECT
                ),
                params![task_id, idempotency_key],
                tool_attempt_from_row,
            )
            .optional()?;

        Ok(match latest {
            Some(attempt)
                if matches!(
                    attempt.status,
                    ToolAttemptStatus::Started
                        | ToolAttemptStatus::Unknown
                        | ToolAttemptStatus::NeedsUser
                ) =>
            {
                ToolReplayDecision::ReconcileIncomplete(attempt)
            }
            Some(_) | None => ToolReplayDecision::Execute,
        })
    }
}

const TOOL_ATTEMPT_SELECT: &str = "SELECT
    attempt_id, task_id, tool_name, idempotency_key, attempt_number,
    status, risk_level, input_digest, target_json, policy_json,
    result_type, receipt_json, verification_json, started_at_ms, finished_at_ms
    FROM tool_attempts";

fn current_task_sequence(
    transaction: &Transaction<'_>,
    task_id: &str,
) -> StorageResult<Option<i64>> {
    transaction
        .query_row(
            "SELECT last_event_sequence FROM tasks WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::from)
}

fn upsert_task(transaction: &Transaction<'_>, snapshot: &TaskSnapshot) -> StorageResult<()> {
    transaction.execute(
        "INSERT INTO tasks(
            task_id, task_run_id, trace_id, lifecycle, title, current_step,
            checkpoint_json, last_event_sequence, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(task_id) DO UPDATE SET
            task_run_id = excluded.task_run_id,
            trace_id = excluded.trace_id,
            lifecycle = excluded.lifecycle,
            title = excluded.title,
            current_step = excluded.current_step,
            checkpoint_json = excluded.checkpoint_json,
            last_event_sequence = excluded.last_event_sequence,
            updated_at_ms = excluded.updated_at_ms",
        params![
            snapshot.task_id,
            snapshot.task_run_id,
            snapshot.trace_id,
            encode_enum(snapshot.lifecycle)?,
            snapshot.title,
            snapshot.current_step,
            encode_optional_json(snapshot.checkpoint.as_ref())?,
            snapshot.last_event_sequence,
            snapshot.created_at_ms,
            snapshot.updated_at_ms
        ],
    )?;
    Ok(())
}

fn task_snapshot_from_row(row: &Row<'_>) -> rusqlite::Result<TaskSnapshot> {
    Ok(TaskSnapshot {
        task_id: row.get(0)?,
        task_run_id: row.get(1)?,
        trace_id: row.get(2)?,
        lifecycle: decode_enum(row.get(3)?, "TaskLifecycle")?,
        title: row.get(4)?,
        current_step: row.get(5)?,
        checkpoint: decode_optional_json(row.get(6)?)?,
        last_event_sequence: row.get(7)?,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
    })
}

fn task_event_from_row(row: &Row<'_>) -> rusqlite::Result<TaskEvent> {
    Ok(TaskEvent {
        event_id: row.get(0)?,
        task_id: row.get(1)?,
        sequence: row.get(2)?,
        event_kind: row.get(3)?,
        payload: decode_json(row.get(4)?)?,
        projection: decode_json(row.get(5)?)?,
        occurred_at_ms: row.get(6)?,
    })
}

fn tool_attempt_from_row(row: &Row<'_>) -> rusqlite::Result<ToolAttempt> {
    let status_value: String = row.get(5)?;
    let status = parse_tool_attempt_status(&status_value).ok_or_else(|| {
        conversion_error(StorageError::InvalidEnum {
            kind: "ToolAttemptStatus",
            value: status_value,
        })
    })?;
    Ok(ToolAttempt {
        attempt_id: row.get(0)?,
        task_id: row.get(1)?,
        tool_name: row.get(2)?,
        idempotency_key: row.get(3)?,
        attempt_number: row.get(4)?,
        status,
        risk_level: decode_enum(row.get(6)?, "ToolRiskLevel")?,
        input_digest: row.get(7)?,
        target: decode_optional_json(row.get(8)?)?,
        policy: decode_optional_json(row.get(9)?)?,
        result_type: decode_optional_enum(row.get(10)?, "ResultType")?,
        receipt: decode_optional_json(row.get(11)?)?,
        verification: decode_optional_json(row.get(12)?)?,
        started_at_ms: row.get(13)?,
        finished_at_ms: row.get(14)?,
    })
}

fn tool_attempt_status_as_str(status: ToolAttemptStatus) -> &'static str {
    match status {
        ToolAttemptStatus::Started => "started",
        ToolAttemptStatus::Succeeded => "succeeded",
        ToolAttemptStatus::Failed => "failed",
        ToolAttemptStatus::Unknown => "unknown",
        ToolAttemptStatus::Cancelled => "cancelled",
        ToolAttemptStatus::NeedsUser => "needs_user",
    }
}

fn parse_tool_attempt_status(value: &str) -> Option<ToolAttemptStatus> {
    match value {
        "started" => Some(ToolAttemptStatus::Started),
        "succeeded" => Some(ToolAttemptStatus::Succeeded),
        "failed" => Some(ToolAttemptStatus::Failed),
        "unknown" => Some(ToolAttemptStatus::Unknown),
        "cancelled" => Some(ToolAttemptStatus::Cancelled),
        "needs_user" => Some(ToolAttemptStatus::NeedsUser),
        _ => None,
    }
}

fn encode_enum<T: Serialize>(value: T) -> StorageResult<String> {
    match serde_json::to_value(value)? {
        Value::String(value) => Ok(value),
        _ => unreachable!("serializable protocol enums always produce strings"),
    }
}

fn encode_optional_enum<T: Serialize>(value: Option<T>) -> StorageResult<Option<String>> {
    value.map(encode_enum).transpose()
}

fn decode_enum<T: DeserializeOwned>(value: String, kind: &'static str) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(value.clone()))
        .map_err(|_| conversion_error(StorageError::InvalidEnum { kind, value }))
}

fn decode_optional_enum<T: DeserializeOwned>(
    value: Option<String>,
    kind: &'static str,
) -> rusqlite::Result<Option<T>> {
    value.map(|value| decode_enum(value, kind)).transpose()
}

fn encode_optional_json(value: Option<&Value>) -> StorageResult<Option<String>> {
    value
        .map(serde_json::to_string)
        .transpose()
        .map_err(Into::into)
}

fn decode_json<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|error| conversion_error(StorageError::Json(error)))
}

fn decode_optional_json<T: DeserializeOwned>(value: Option<String>) -> rusqlite::Result<Option<T>> {
    value.map(decode_json).transpose()
}

fn conversion_error(error: StorageError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
