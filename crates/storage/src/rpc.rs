use crate::{Storage, StorageError, StorageResult};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 回执只保存规范化结果；不保存含密钥/音频的原始请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResult {
    pub ok: bool,
    pub value: Option<Value>,
    pub error: Option<String>,
}

impl RpcResult {
    /// 成功与失败互斥；损坏回执不能被当成可重放的成功响应。
    fn validate(&self) -> StorageResult<()> {
        if (self.ok && self.error.is_none())
            || (!self.ok
                && self.value.is_none()
                && self.error.as_ref().is_some_and(|e| !e.trim().is_empty()))
        {
            Ok(())
        } else {
            Err(StorageError::RpcReconciliation)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcReceiptStatus {
    NotApplied,
    Started,
    Reconciliation,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcReceipt {
    pub request_id: String,
    pub kind: String,
    pub payload_digest: String,
    pub protocol_version: u32,
    pub status: RpcReceiptStatus,
    pub result: Option<RpcResult>,
    pub reconciliation_evidence: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub enum RpcDispatchDecision {
    Execute,
    Replay(RpcResult),
}

impl Storage {
    pub fn load_rpc_receipt(&self, id: &str) -> StorageResult<Option<RpcReceipt>> {
        let raw = self.connection.query_row(
            "SELECT kind,payload_digest,protocol_version,status,response_json,reconciliation_evidence,created_at_ms,updated_at_ms FROM rpc_receipts WHERE request_id=?1",
            [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, u32>(2)?,row.get::<_, String>(3)?,row.get::<_, Option<String>>(4)?,row.get::<_, Option<String>>(5)?,row.get::<_, i64>(6)?,row.get::<_, i64>(7)?)),
        ).optional()?;
        raw.map(
            |(
                kind,
                payload_digest,
                protocol_version,
                status,
                response,
                reconciliation_evidence,
                created_at_ms,
                updated_at_ms,
            )| {
                let status: RpcReceiptStatus = serde_json::from_value(Value::String(status))?;
                let result: Option<RpcResult> = response
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?;
                if let Some(result) = &result {
                    result.validate()?;
                }
                if (status == RpcReceiptStatus::Completed) != result.is_some() {
                    return Err(StorageError::RpcReconciliation);
                }
                Ok(RpcReceipt {
                    request_id: id.into(),
                    kind,
                    payload_digest,
                    protocol_version,
                    status,
                    result,
                    reconciliation_evidence,
                    created_at_ms,
                    updated_at_ms,
                })
            },
        )
        .transpose()
    }

    /// 先持久化领取，再执行。崩溃窗口保守进入对账，而不是假定尚未执行。
    /// 调用方持有 Host 存储锁；数据库唯一键同时防止多个连接重复领取。
    pub fn claim_rpc(
        &mut self,
        id: &str,
        kind: &str,
        digest: &str,
        version: u32,
        now: i64,
    ) -> StorageResult<RpcDispatchDecision> {
        self.connection.execute(
            "INSERT OR IGNORE INTO rpc_receipts(request_id,kind,payload_digest,protocol_version,status,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,'not_applied',?5,?5)",
            params![id,kind,digest,version,now],
        )?;
        let saved = self
            .load_rpc_receipt(id)?
            .ok_or(StorageError::RpcReconciliation)?;
        if saved.kind != kind || saved.payload_digest != digest || saved.protocol_version != version
        {
            self.connection.execute(
                "UPDATE rpc_receipts SET conflicts=conflicts+1 WHERE request_id=?1",
                [id],
            )?;
            return Err(StorageError::RpcConflict);
        }
        if saved.status == RpcReceiptStatus::Completed {
            return saved
                .result
                .map(RpcDispatchDecision::Replay)
                .ok_or(StorageError::RpcReconciliation);
        }
        if self.connection.execute(
            "UPDATE rpc_receipts SET status='started',updated_at_ms=?2 WHERE request_id=?1 AND status='not_applied'",
            params![id,now],
        )? == 1 { return Ok(RpcDispatchDecision::Execute); }
        self.connection.execute("UPDATE rpc_receipts SET status='reconciliation',updated_at_ms=?2 WHERE request_id=?1 AND status='started'", params![id,now])?;
        Err(StorageError::RpcReconciliation)
    }

    pub fn finish_rpc(&mut self, id: &str, result: &RpcResult, now: i64) -> StorageResult<()> {
        result.validate()?;
        if self.connection.execute(
            "UPDATE rpc_receipts SET status='completed',response_json=?2,updated_at_ms=?3 WHERE request_id=?1 AND status IN ('started','reconciliation')",
            params![id,serde_json::to_string(result)?,now],
        )? != 1 { return Err(StorageError::RpcReconciliation); }
        Ok(())
    }

    /// Host 读回并核实操作已执行后保存确定结果；不能凭超时或 Agent 声称成功调用。
    /// 只接受待对账记录，迟到结果和重复对账都不能覆盖已经保存的回执。
    pub fn reconcile_rpc_applied(
        &mut self,
        id: &str,
        result: &RpcResult,
        evidence: &str,
        now: i64,
    ) -> StorageResult<()> {
        result.validate()?;
        if evidence.trim().is_empty() {
            return Err(StorageError::RpcReconciliation);
        }
        if self.connection.execute(
            "UPDATE rpc_receipts SET status='completed',response_json=?2,reconciliation_evidence=?3,updated_at_ms=?4 WHERE request_id=?1 AND status='reconciliation'",
            params![id, serde_json::to_string(result)?, evidence, now],
        )? != 1 {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(())
    }

    /// 只供 Host 读回核对后调用，不暴露给 Agent。证据摘要不可为空；
    /// 不提供“超时即未执行”入口。已保存回执不能被撤销成可重放状态。
    pub fn reconcile_rpc_not_applied(
        &mut self,
        id: &str,
        evidence: &str,
        now: i64,
    ) -> StorageResult<()> {
        if evidence.trim().is_empty() {
            return Err(StorageError::RpcReconciliation);
        }
        if self.connection.execute(
            "UPDATE rpc_receipts SET status='not_applied',updated_at_ms=?2,reconciliation_evidence=?3 WHERE request_id=?1 AND status='reconciliation'",
            params![id,now,evidence],
        )? != 1 { return Err(StorageError::RpcReconciliation); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn applied_reconciliation_survives_restart_and_cannot_be_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rpc.sqlite");
        {
            let mut storage = Storage::open(&path).unwrap();
            storage
                .claim_rpc("applied", "workflow.request", "a", 1, 10)
                .unwrap();
        }
        let result = RpcResult {
            ok: true,
            value: Some(serde_json::json!({"commit":"verified-fixture"})),
            error: None,
        };
        {
            let mut storage = Storage::open(&path).unwrap();
            assert!(storage
                .reconcile_rpc_applied("applied", &result, "readback", 11)
                .is_err());
            assert!(matches!(
                storage.claim_rpc("applied", "workflow.request", "a", 1, 12),
                Err(StorageError::RpcReconciliation)
            ));
            assert!(storage
                .reconcile_rpc_applied("applied", &result, " ", 13)
                .is_err());
            storage
                .reconcile_rpc_applied(
                    "applied",
                    &result,
                    "verified commit and operation receipt",
                    14,
                )
                .unwrap();
            let late = RpcResult {
                ok: false,
                value: None,
                error: Some("late timeout".into()),
            };
            assert!(storage.finish_rpc("applied", &late, 15).is_err());
            assert!(storage
                .reconcile_rpc_applied("applied", &late, "late evidence", 15)
                .is_err());
            assert!(storage
                .reconcile_rpc_not_applied("applied", "late evidence", 15)
                .is_err());
        }
        let mut storage = Storage::open(path).unwrap();
        let receipt = storage.load_rpc_receipt("applied").unwrap().unwrap();
        assert_eq!(receipt.status, RpcReceiptStatus::Completed);
        assert_eq!((receipt.created_at_ms, receipt.updated_at_ms), (10, 14));
        assert!(receipt.reconciliation_evidence.is_some());
        assert!(matches!(
            storage.claim_rpc("applied", "workflow.request", "a", 1, 20).unwrap(),
            RpcDispatchDecision::Replay(saved) if saved == result
        ));
    }

    #[test]
    fn malformed_results_are_rejected_before_write_and_on_readback() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage
            .claim_rpc("invalid", "workflow.request", "a", 1, 1)
            .unwrap();
        for result in [
            RpcResult {
                ok: true,
                value: Some(Value::Null),
                error: Some("contradiction".into()),
            },
            RpcResult {
                ok: false,
                value: None,
                error: Some(" ".into()),
            },
            RpcResult {
                ok: false,
                value: Some(Value::Null),
                error: Some("failed".into()),
            },
        ] {
            assert!(storage.finish_rpc("invalid", &result, 2).is_err());
            assert_eq!(
                storage.load_rpc_receipt("invalid").unwrap().unwrap().status,
                RpcReceiptStatus::Started
            );
        }
        storage.connection.execute(
            "UPDATE rpc_receipts SET status='completed',response_json=?1 WHERE request_id='invalid'",
            [r#"{"ok":true,"value":null,"error":"corrupt"}"#],
        ).unwrap();
        assert!(storage.load_rpc_receipt("invalid").is_err());
        assert!(storage
            .claim_rpc("invalid", "workflow.request", "a", 1, 3)
            .is_err());
    }

    #[test]
    fn replay_conflict_and_unknown_require_explicit_reconciliation() {
        let mut storage = Storage::open_in_memory().unwrap();
        assert!(matches!(
            storage
                .claim_rpc("req_1", "workflow.request", "a", 1, 1)
                .unwrap(),
            RpcDispatchDecision::Execute
        ));
        assert!(matches!(
            storage.claim_rpc("req_1", "workflow.request", "b", 1, 2),
            Err(StorageError::RpcConflict)
        ));
        assert!(matches!(
            storage.claim_rpc("req_1", "workflow.request", "a", 1, 2),
            Err(StorageError::RpcReconciliation)
        ));
        assert!(storage.reconcile_rpc_not_applied("req_1", "", 3).is_err());
        storage
            .reconcile_rpc_not_applied("req_1", "fixture proved zero invocations", 3)
            .unwrap();
        assert_eq!(
            storage
                .load_rpc_receipt("req_1")
                .unwrap()
                .unwrap()
                .reconciliation_evidence
                .as_deref(),
            Some("fixture proved zero invocations")
        );
        assert!(matches!(
            storage
                .claim_rpc("req_1", "workflow.request", "a", 1, 4)
                .unwrap(),
            RpcDispatchDecision::Execute
        ));
        let result = RpcResult {
            ok: true,
            value: Some(serde_json::json!({"done":true})),
            error: None,
        };
        storage.finish_rpc("req_1", &result, 5).unwrap();
        assert!(
            matches!(storage.claim_rpc("req_1", "workflow.request", "a", 1, 6).unwrap(), RpcDispatchDecision::Replay(saved) if saved == result)
        );
        assert!(storage
            .reconcile_rpc_not_applied("req_1", "not valid", 7)
            .is_err());
    }
    #[test]
    fn receipts_survive_reopen_without_replaying_an_interrupted_operation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rpc.sqlite");
        {
            let mut storage = Storage::open(&path).unwrap();
            storage
                .claim_rpc("req_crash", "workflow.request", "a", 1, 1)
                .unwrap();
            storage
                .claim_rpc("req_done", "workflow.request", "b", 1, 1)
                .unwrap();
            storage
                .finish_rpc(
                    "req_done",
                    &RpcResult {
                        ok: true,
                        value: Some(Value::Null),
                        error: None,
                    },
                    2,
                )
                .unwrap();
        }
        let mut storage = Storage::open(path).unwrap();
        assert!(matches!(
            storage.claim_rpc("req_crash", "workflow.request", "a", 1, 3),
            Err(StorageError::RpcReconciliation)
        ));
        assert!(matches!(
            storage
                .claim_rpc("req_done", "workflow.request", "b", 1, 3)
                .unwrap(),
            RpcDispatchDecision::Replay(_)
        ));
    }
}
