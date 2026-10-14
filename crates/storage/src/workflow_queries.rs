//! 工作流只读查询边界；状态变更留在 workflow 与 workflow_background。

use crate::{
    workflow_dto::{
        decode_snapshot, WorkflowBackground, WorkflowGrant, WorkflowNotification,
        WorkflowSnapshotDto,
    },
    Storage, StorageError, StorageResult,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn invalid(message: &str) -> StorageError {
    StorageError::InvalidWorkflow(message.into())
}

impl Storage {
    /// 启动恢复采用全量校验，不能把损坏的会话悄悄丢掉后继续通知 Worker。
    ///
    /// 查询失败时尚未发布任何工作流，调用方可展示恢复错误并等待核对。
    pub fn workflow_recovery_snapshots_dto(&self) -> StorageResult<Vec<WorkflowSnapshotDto>> {
        let mut snapshots = Vec::new();
        for session in self.load_client_sessions()? {
            snapshots.extend(self.load_workflows_dto(&session.session_id)?);
        }
        Ok(snapshots)
    }

    /// 队列由事件序号提供持久游标。消费确认只在主 Pi 成功接收后推进。
    pub(crate) fn workflow_notifications(&self, session: &str) -> StorageResult<Vec<Value>> {
        let mut statement = self.connection.prepare(
            "SELECT e.event_json,w.workflow_id FROM workflow_events e JOIN workflows w ON w.workflow_id=e.workflow_id JOIN workflow_plans p ON p.workflow_id=w.workflow_id AND p.version=w.current_version WHERE p.session_id=?1 AND e.sequence>w.consumed_sequence
            AND json_extract(e.event_json,'$.kind')<>'run.activity' ORDER BY e.rowid LIMIT 100",
        )?;
        let rows = statement.query_map([session], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (raw, id) = row?;
            Ok(json!({"workflowId":id,"event":serde_json::from_str::<Value>(&raw)?}))
        })
        .collect()
    }

    /// 面向 Host/UI 的类型化通知查询；旧 JSON 查询暂时保留给内部协调状态机。
    pub fn workflow_notifications_dto(
        &self,
        session: &str,
    ) -> StorageResult<Vec<WorkflowNotification>> {
        self.workflow_notifications(session)?
            .into_iter()
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    StorageError::InvalidWorkflow(format!("invalid workflow notification: {error}"))
                })
            })
            .collect()
    }

    pub(crate) fn load_workflow(&self, id: &str) -> StorageResult<Option<Value>> {
        let base = self.connection.query_row(
            "SELECT p.plan_json,p.digest,w.status FROM workflows w JOIN workflow_plans p ON p.workflow_id=w.workflow_id AND p.version=w.current_version WHERE w.workflow_id=?1",
            [id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)),
        ).optional()?;
        let Some((plan, digest, status)) = base else {
            return Ok(None);
        };
        let load = |sql: &str| -> StorageResult<Vec<Value>> {
            let mut statement = self.connection.prepare(sql)?;
            let rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        };
        let integrations = load("SELECT evidence_json FROM workflow_evidence WHERE workflow_id=?1 AND kind='integration'")?;
        Ok(Some(json!({
            "plan":serde_json::from_str::<Value>(&plan)?,"digest":digest,"status":status,
            "runs":load("SELECT run_json FROM agent_runs WHERE workflow_id=?1 ORDER BY rowid")?,
            "events":load("SELECT event_json FROM workflow_events WHERE workflow_id=?1 ORDER BY sequence")?,
            "findings":load("SELECT evidence_json FROM workflow_evidence WHERE workflow_id=?1 AND kind='finding'")?,
            "integration":integrations.first(),
            "background":self.workflow_background(id)?,
        })))
    }

    /// 类型化查询出口。内部写入和状态转换仍使用 `load_workflow` 的兼容快照，
    /// 但跨进程读取必须经过 DTO 解码，避免任意 JSON 进入 WebView。
    pub fn load_workflow_dto(&self, id: &str) -> StorageResult<Option<WorkflowSnapshotDto>> {
        self.load_workflow(id)?.map(decode_snapshot).transpose()
    }

    pub(crate) fn load_workflows(&self, session: &str) -> StorageResult<Vec<Value>> {
        let mut statement = self.connection.prepare(
            "SELECT w.workflow_id FROM workflows w JOIN workflow_plans p ON p.workflow_id=w.workflow_id AND p.version=w.current_version WHERE p.session_id=?1 ORDER BY p.created_at_ms DESC",
        )?;
        let ids = statement
            .query_map([session], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                self.load_workflow(id)?
                    .ok_or_else(|| invalid("missing workflow"))
            })
            .collect()
    }

    pub fn load_workflows_dto(&self, session: &str) -> StorageResult<Vec<WorkflowSnapshotDto>> {
        self.load_workflows(session)?
            .into_iter()
            .map(decode_snapshot)
            .collect()
    }

    /// 真人批准事务写入的 grant 不可由 Worker 创建；精细分工只能继承同一意图。
    pub(crate) fn workflow_grant(&self, id: &str) -> StorageResult<Option<Value>> {
        let raw = self
            .connection
            .query_row(
                "SELECT intent_version,plan_version,digest,repository,actions_json,approved_at_ms
             FROM workflow_grants WHERE workflow_id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?;
        raw.map(|(intent, version, digest, repository, actions, now)| {
            Ok(json!({
                "intentVersion":intent,"approvedPlanVersion":version,"digest":digest,
                "repository":repository,"actions":serde_json::from_str::<Value>(&actions)?,
                "approvedAtMs":now,"actor":"user"
            }))
        })
        .transpose()
    }

    pub fn workflow_grant_dto(&self, id: &str) -> StorageResult<Option<WorkflowGrant>> {
        self.workflow_grant(id)?
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|error| invalid(&format!("invalid workflow grant: {error}")))
            })
            .transpose()
    }

    /// 跨 Session 查询只返回真实快照；名称用普通子串匹配，不执行模型生成的 SQL。
    pub(crate) fn find_workflows(
        &self,
        name: &str,
        repository: &str,
        status: &str,
    ) -> StorageResult<Vec<Value>> {
        let mut statement = self.connection.prepare(
            "SELECT w.workflow_id FROM workflows w JOIN workflow_plans p
             ON p.workflow_id=w.workflow_id AND p.version=w.current_version
             LEFT JOIN workflow_coordinators c ON c.workflow_id=w.workflow_id
             WHERE (?1='' OR instr(lower(json_extract(p.plan_json,'$.title')),lower(?1))>0)
             AND (?2='' OR json_extract(p.plan_json,'$.repository')=?2)
             AND (?3='' OR w.status=?3 OR c.execution_status=?3)
             ORDER BY p.created_at_ms DESC LIMIT 30",
        )?;
        let ids = statement
            .query_map(params![name, repository, status], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                self.load_workflow(id)?
                    .ok_or_else(|| invalid("missing workflow"))
            })
            .collect()
    }

    /// 跨 Session 读取与单个快照采用同一 DTO 边界，不能让搜索入口绕过解码。
    pub fn find_workflows_dto(
        &self,
        name: &str,
        repository: &str,
        status: &str,
    ) -> StorageResult<Vec<WorkflowSnapshotDto>> {
        self.find_workflows(name, repository, status)?
            .into_iter()
            .map(decode_snapshot)
            .collect()
    }

    pub(crate) fn workflow_background(&self, id: &str) -> StorageResult<Value> {
        let value = self.connection.query_row(
            "SELECT execution_status,last_activity_ms,no_progress,reason FROM workflow_coordinators WHERE workflow_id=?1",
            [id], |row| Ok(json!({"executionStatus":row.get::<_,String>(0)?,
                "lastActivityAtMs":row.get::<_,i64>(1)?,"noProgress":row.get::<_,u32>(2)?,
                "reason":row.get::<_,Option<String>>(3)?})),
        ).optional()?.unwrap_or(json!({"executionStatus":"idle","lastActivityAtMs":0,"noProgress":0,"reason":null}));
        let mut statement = self.connection.prepare(
            "SELECT q.request_id,q.run_id,q.kind,q.request_json,q.status
             FROM workflow_decision_requests q JOIN workflows w ON w.workflow_id=q.workflow_id
             JOIN workflow_plans p ON p.workflow_id=w.workflow_id AND p.version=w.current_version
             JOIN agent_runs r ON r.run_id=q.run_id
             WHERE q.workflow_id=?1 AND q.status!='answered'
             AND q.intent_version=json_extract(p.plan_json,'$.intentVersion')
             AND json_extract(r.run_json,'$.status')='running'
             ORDER BY q.rowid LIMIT 100",
        )?;
        let requests=statement.query_map([id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)))?
            .map(|row|{let (request,run,kind,raw,status)=row?; Ok(json!({"requestId":request,"runId":run,"kind":kind,"input":serde_json::from_str::<Value>(&raw)?,"status":status}))})
            .collect::<StorageResult<Vec<Value>>>()?;
        Ok(json!({"coordinator":value,"grant":self.workflow_grant(id)?,"requests":requests}))
    }

    /// 后台状态的公开查询 DTO；协调器内部仍使用 JSON 快照以保持迁移兼容。
    pub fn workflow_background_dto(&self, id: &str) -> StorageResult<WorkflowBackground> {
        // Option 原生处理 null；一次解码所有字段，避免手动索引遗漏未知字段。
        serde_json::from_value(self.workflow_background(id)?)
            .map_err(|error| invalid(&format!("invalid workflow background: {error}")))
    }
}
