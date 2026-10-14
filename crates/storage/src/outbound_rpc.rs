use crate::{Storage, StorageError, StorageResult};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 传输确认不代表实施或验证成功；业务终态仍由工作流事件与版本证据决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboundStatus {
    NotSent,
    Queued,
    Sending,
    Acknowledged,
    Reconciliation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundReceipt {
    pub request_id: String,
    pub kind: String,
    pub payload_digest: String,
    pub protocol_version: u32,
    pub status: OutboundStatus,
    pub response_kind: Option<String>,
    pub reconciliation_evidence: Option<String>,
}

impl Storage {
    /// 发送账本不保存原始请求、PCM 或响应正文，仅记录可对账的身份及传输状态。
    pub fn load_outbound_rpc(&self, id: &str) -> StorageResult<Option<OutboundReceipt>> {
        let raw = self.connection.query_row(
            "SELECT kind,payload_digest,protocol_version,status,response_kind,reconciliation_evidence
             FROM outbound_rpc_receipts WHERE request_id=?1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?, row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?)),
        ).optional()?;
        raw.map(
            |(
                kind,
                payload_digest,
                protocol_version,
                status,
                response_kind,
                reconciliation_evidence,
            )| {
                let status = serde_json::from_value(serde_json::Value::String(status))?;
                if (status == OutboundStatus::Acknowledged) != response_kind.is_some() {
                    return Err(StorageError::RpcReconciliation);
                }
                Ok(OutboundReceipt {
                    request_id: id.into(),
                    kind,
                    payload_digest,
                    protocol_version,
                    status,
                    response_kind,
                    reconciliation_evidence,
                })
            },
        )
        .transpose()
    }

    /// 返回 true 时才允许排入监督器；重复排队不产生第二份进程消息。
    /// 原请求已收到 ACK 或结果未知时明确拒绝，不能伪造业务成功或重发。
    pub fn queue_outbound_rpc(
        &mut self,
        id: &str,
        kind: &str,
        digest: &str,
        version: u32,
        now: i64,
    ) -> StorageResult<bool> {
        self.connection.execute(
            "INSERT OR IGNORE INTO outbound_rpc_receipts
             (request_id,kind,payload_digest,protocol_version,status,created_at_ms,updated_at_ms)
             VALUES(?1,?2,?3,?4,'not_sent',?5,?5)",
            params![id, kind, digest, version, now],
        )?;
        let saved = self
            .load_outbound_rpc(id)?
            .ok_or(StorageError::RpcReconciliation)?;
        if saved.kind != kind || saved.payload_digest != digest || saved.protocol_version != version
        {
            return Err(StorageError::RpcConflict);
        }
        if saved.status == OutboundStatus::Queued {
            return Ok(false);
        }
        if saved.status != OutboundStatus::NotSent {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status='queued',updated_at_ms=?2
             WHERE request_id=?1 AND status='not_sent'",
            params![id, now],
        )? == 1)
    }

    /// 必须在第一字节写入前落盘。部分写入、flush 失败和崩溃都按可能已执行处理。
    pub fn start_outbound_rpc(&mut self, id: &str, now: i64) -> StorageResult<()> {
        if self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status='sending',updated_at_ms=?2
             WHERE request_id=?1 AND status='queued'",
            params![id, now],
        )? != 1
        {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(())
    }

    /// 仅当进程命令通道拒收、可以证明尚未入队时撤销排队状态。
    pub fn release_outbound_rpc(&mut self, id: &str, now: i64) -> StorageResult<()> {
        if self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status='not_sent',updated_at_ms=?2
             WHERE request_id=?1 AND status='queued'",
            params![id, now],
        )? != 1
        {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(())
    }

    pub fn acknowledge_outbound_rpc(
        &mut self,
        id: &str,
        kind: &str,
        now: i64,
    ) -> StorageResult<()> {
        if self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status='acknowledged',response_kind=?2,updated_at_ms=?3
             WHERE request_id=?1 AND status='sending'", params![id, kind, now],
        )? != 1 {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(())
    }

    /// Worker 断开只将已尝试发送的请求变为待对账；内存中的未发送队列可以继续。
    pub fn interrupt_outbound_rpc(&mut self, now: i64) -> StorageResult<usize> {
        Ok(self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status='reconciliation',updated_at_ms=?1
             WHERE status='sending'",
            [now],
        )?)
    }

    /// 仅在唯一 Supervisor 初始化时调用。queued 证明未写管道，可由领域状态重新提交；
    /// 不持久化 payload，因此不会自动重建语音或绕过最新授权。
    pub fn recover_outbound_rpc(&mut self, now: i64) -> StorageResult<usize> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE outbound_rpc_receipts SET status='not_sent',updated_at_ms=?1
             WHERE status='queued'",
            [now],
        )?;
        let unknown = transaction.execute(
            "UPDATE outbound_rpc_receipts SET status='reconciliation',updated_at_ms=?1
             WHERE status='sending'",
            [now],
        )?;
        transaction.commit()?;
        Ok(unknown)
    }

    /// Host-only 对账入口，调用者必须先读回 Provider/工作区/操作回执取得证据。
    /// None 表示已核实未发送/执行，Some 表示已核实接收；超时不能作为证据。
    pub fn reconcile_outbound_rpc(
        &mut self,
        id: &str,
        response_kind: Option<&str>,
        evidence: &str,
        now: i64,
    ) -> StorageResult<()> {
        if evidence.trim().is_empty() || response_kind.is_some_and(|kind| kind.trim().is_empty()) {
            return Err(StorageError::RpcReconciliation);
        }
        let status = if response_kind.is_some() {
            "acknowledged"
        } else {
            "not_sent"
        };
        if self.connection.execute(
            "UPDATE outbound_rpc_receipts SET status=?2,response_kind=?3,
             reconciliation_evidence=?4,updated_at_ms=?5
             WHERE request_id=?1 AND status='reconciliation'",
            params![id, status, response_kind, evidence, now],
        )? != 1
        {
            return Err(StorageError::RpcReconciliation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_requests_deduplicate_and_sent_requests_require_evidence() {
        let mut db = Storage::open_in_memory().unwrap();
        assert!(db
            .queue_outbound_rpc("req_a", "workflow.control", "digest", 1, 1)
            .unwrap());
        assert!(!db
            .queue_outbound_rpc("req_a", "workflow.control", "digest", 1, 2)
            .unwrap());
        assert!(matches!(
            db.queue_outbound_rpc("req_a", "workflow.control", "changed", 1, 3),
            Err(StorageError::RpcConflict)
        ));
        db.start_outbound_rpc("req_a", 4).unwrap();
        assert_eq!(db.recover_outbound_rpc(5).unwrap(), 1);
        assert!(db
            .queue_outbound_rpc("req_a", "workflow.control", "digest", 1, 6)
            .is_err());
        assert!(db.reconcile_outbound_rpc("req_a", None, "", 7).is_err());
        db.reconcile_outbound_rpc("req_a", None, "provider log proves no execution", 8)
            .unwrap();
        assert!(db
            .queue_outbound_rpc("req_a", "workflow.control", "digest", 1, 9)
            .unwrap());
        db.start_outbound_rpc("req_a", 10).unwrap();
        db.acknowledge_outbound_rpc("req_a", "workflow.control.accepted", 11)
            .unwrap();
        assert!(db
            .reconcile_outbound_rpc("req_a", None, "cannot erase ACK", 12)
            .is_err());
        assert_eq!(
            db.load_outbound_rpc("req_a").unwrap().unwrap().status,
            OutboundStatus::Acknowledged
        );
    }

    #[test]
    fn recovery_separates_unsent_from_unknown_and_preserves_acknowledgements() {
        let path = std::env::temp_dir().join(format!(
            "semi-os-outbound-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut db = Storage::open(&path).unwrap();
            for id in ["req_unsent", "req_partial", "req_ack"] {
                db.queue_outbound_rpc(id, "workflow.control", id, 1, 1)
                    .unwrap();
            }
            db.start_outbound_rpc("req_partial", 2).unwrap();
            db.start_outbound_rpc("req_ack", 2).unwrap();
            db.acknowledge_outbound_rpc("req_ack", "workflow.control.accepted", 3)
                .unwrap();
        }
        {
            let mut db = Storage::open(&path).unwrap();
            assert_eq!(db.recover_outbound_rpc(4).unwrap(), 1);
            assert_eq!(
                db.load_outbound_rpc("req_unsent").unwrap().unwrap().status,
                OutboundStatus::NotSent
            );
            assert_eq!(
                db.load_outbound_rpc("req_ack").unwrap().unwrap().status,
                OutboundStatus::Acknowledged
            );
            db.reconcile_outbound_rpc(
                "req_partial",
                Some("workflow.control.accepted"),
                "matched operation receipt",
                5,
            )
            .unwrap();
            assert!(db
                .queue_outbound_rpc("req_partial", "workflow.control", "req_partial", 1, 6)
                .is_err());
        }
        let _ = std::fs::remove_file(path);
    }
}
