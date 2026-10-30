use crate::{Storage, StorageError, StorageResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// 只保存动作阶段和脱敏摘要；原始文本不进入动作审计表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActionRecord {
    pub request_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub action_kind: String,
    pub lease_generation: u64,
    pub stage: String,
    pub summary: String,
}

impl Storage {
    pub fn claim_desktop_action(
        &mut self,
        record: &DesktopActionRecord,
        approval: Option<&str>,
        digest: &str,
        now: i64,
    ) -> StorageResult<()> {
        self.connection.execute(
            "INSERT INTO desktop_actions(request_id,task_id,attempt_id,approval_id,input_digest,action_kind,lease_generation,stage,summary,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,'not_dispatched',?8,?9,?9)",
            params![record.request_id,record.task_id,record.attempt_id,approval,digest,record.action_kind,record.lease_generation,record.summary,now],
        )?;
        Ok(())
    }

    pub fn update_desktop_action(
        &mut self,
        request: &str,
        stage: &str,
        generation: u64,
        summary: &str,
        now: i64,
    ) -> StorageResult<()> {
        // 终态不可回退；可能派发的动作只能核对结果，不能再次成为未派发。
        let changed = self.connection.execute(
            "UPDATE desktop_actions SET stage=?2,lease_generation=?3,summary=?4,updated_at_ms=?5
             WHERE request_id=?1 AND (
               (stage='not_dispatched' AND ?2 IN ('possibly_dispatched','verified','needs_user','failure')) OR
               (stage='possibly_dispatched' AND ?2 IN ('verified','unknown','needs_user','failure'))
             )",
            params![request,stage,generation,summary,now],
        )?;
        if changed != 1 {
            return Err(StorageError::InvalidDesktopTransition);
        }
        Ok(())
    }

    pub fn desktop_approval_matches(
        &self,
        approval: &str,
        task: &str,
        tool: &str,
        digest: &str,
        attempt: Option<&str>,
        now: i64,
    ) -> StorageResult<bool> {
        self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM approvals a WHERE a.approval_id=?1 AND a.task_id=?2 AND a.action=?3 AND a.payload_digest=?4 AND a.decision='approved' AND a.attempt_id IS NULL AND a.decided_at_ms<=?6 AND a.decided_at_ms>=?6-120000 AND NOT EXISTS(SELECT 1 FROM desktop_actions d WHERE d.approval_id=a.approval_id AND (?5 IS NULL OR d.attempt_id<>?5)))",
            params![approval,task,tool,digest,attempt,now], |row| row.get(0),
        ).map_err(Into::into)
    }

    pub fn recover_desktop_actions(&mut self, now: i64) -> StorageResult<()> {
        self.connection.execute("UPDATE desktop_actions SET stage='unknown',summary='进程重启，可能已经执行；请重新观察核对',updated_at_ms=?1 WHERE stage='possibly_dispatched'", [now])?;
        Ok(())
    }

    pub fn load_desktop_actions(&self) -> StorageResult<Vec<DesktopActionRecord>> {
        let mut query = self.connection.prepare("SELECT request_id,task_id,attempt_id,action_kind,lease_generation,stage,summary FROM desktop_actions ORDER BY created_at_ms DESC LIMIT 100")?;
        let rows = query.query_map([], |row| {
            Ok(DesktopActionRecord {
                request_id: row.get(0)?,
                task_id: row.get(1)?,
                attempt_id: row.get(2)?,
                action_kind: row.get(3)?,
                lease_generation: row.get(4)?,
                stage: row.get(5)?,
                summary: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}
