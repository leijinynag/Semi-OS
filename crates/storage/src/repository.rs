use crate::{
    AgentSessionCheckpoint, NewTaskEvent, StorageError, StorageResult, TaskEvent, TaskSnapshot,
    ToolAttempt, ToolAttemptStatus, ToolReplayDecision,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{path::Path, time::Duration};

pub struct Storage {
    connection: Connection,
}

impl Storage {
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
                attempt.status.as_str(),
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
    let status = ToolAttemptStatus::parse(status_value.clone()).ok_or_else(|| {
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
