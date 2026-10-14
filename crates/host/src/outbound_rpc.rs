use crate::rpc::request_identity;
use semi_os_protocol::Envelope;
use semi_os_storage::{OutboundStatus, Storage};
use std::{
    io,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// 独立连接避免调用方持有桌面 Storage 锁时发生重入死锁。
/// 账本只记录传输身份；ACK 不是任务完成，也不能用它伪造业务结果。
pub(crate) struct OutboundLedger(Mutex<Storage>);

impl OutboundLedger {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let mut storage = Storage::open(path).map_err(io::Error::other)?;
        storage
            .recover_outbound_rpc(now())
            .map_err(io::Error::other)?;
        Ok(Self(Mutex::new(storage)))
    }

    fn with<T>(&self, f: impl FnOnce(&mut Storage) -> io::Result<T>) -> io::Result<T> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| io::Error::other("RPC ledger unavailable"))?;
        f(&mut guard)
    }

    pub(crate) fn queue(&self, envelope: &Envelope) -> io::Result<bool> {
        if !durable(envelope) {
            return Ok(true);
        }
        let (id, kind, digest, version) = request_identity(envelope).map_err(io::Error::other)?;
        self.with(|db| {
            db.queue_outbound_rpc(&id, &kind, &digest, version, now())
                .map_err(|error| io::Error::other(crate::HostError::Storage(error).ui_message()))
        })
    }

    pub(crate) fn start(&self, envelope: &Envelope) -> io::Result<()> {
        if let Envelope::Request { request_id, .. } = envelope {
            if durable(envelope) {
                return self.with(|db| {
                    db.start_outbound_rpc(&request_id.0, now())
                        .map_err(io::Error::other)
                });
            }
        }
        Ok(())
    }

    pub(crate) fn interrupt(&self) -> io::Result<()> {
        self.with(|db| {
            db.interrupt_outbound_rpc(now())
                .map(|_| ())
                .map_err(io::Error::other)
        })
    }

    pub(crate) fn release(&self, envelope: &Envelope) -> io::Result<()> {
        if let Envelope::Request { request_id, .. } = envelope {
            if durable(envelope) {
                return self.with(|db| {
                    db.release_outbound_rpc(&request_id.0, now())
                        .map_err(io::Error::other)
                });
            }
        }
        Ok(())
    }

    pub(crate) fn acknowledge(&self, envelope: &Envelope) -> io::Result<()> {
        let (id, kind, error) = match envelope {
            Envelope::Response {
                request_id, kind, ..
            } => (&request_id.0, kind.as_str(), false),
            Envelope::Error { request_id, .. } => (&request_id.0, "error", true),
            _ => return Ok(()),
        };
        self.with(|db| {
            let Some(receipt) = db.load_outbound_rpc(id).map_err(io::Error::other)? else {
                return Ok(());
            };
            // 异步最终结果允许正常通过；只接受匹配该请求的第一份传输确认。
            if receipt.status == OutboundStatus::Acknowledged {
                return if error
                    || matches_response(&receipt.kind, kind)
                    || (matches!(
                        receipt.kind.as_str(),
                        "workflow.application.prepare"
                            | "workflow.application.apply"
                            | "workflow.run.inspect"
                            | "workflow.run.reconcile"
                            | "workflow.run.steer"
                            | "workflow.run.answer"
                    ) && kind == "workflow.run.result")
                {
                    Ok(())
                } else {
                    Err(io::Error::other("mismatched outbound RPC result"))
                };
            }
            if receipt.status != OutboundStatus::Sending
                || (!error && !matches_response(&receipt.kind, kind))
            {
                return Err(io::Error::other("unexpected outbound RPC acknowledgement"));
            }
            db.acknowledge_outbound_rpc(id, kind, now())
                .map_err(io::Error::other)
        })
    }
}

fn durable(envelope: &Envelope) -> bool {
    // 实时音频与会话控制不可在重启后重放，也不应逐帧触发 SQLite 写入。
    matches!(envelope, Envelope::Request { kind, .. } if !kind.starts_with("voice."))
}

fn matches_response(request: &str, response: &str) -> bool {
    match request {
        "health.check" => response == "health.ready",
        "workflow.application.prepare"
        | "workflow.application.apply"
        | "workflow.run.inspect"
        | "workflow.run.reconcile"
        | "workflow.run.steer"
        | "workflow.run.answer" => response == "workflow.run.accepted",
        "workflow.control" => response == "workflow.control.accepted",
        "workflow.acknowledged" => response == "workflow.received",
        "research.confirmation.required" => response == "research.confirmation.announced",
        "research.persisted" => response == "research.acknowledged",
        "browser.login.open" => response == "browser.login.accepted",
        _ => false,
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
