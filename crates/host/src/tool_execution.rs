use semi_os_protocol::{
    PolicyDecision, ResultType, ToolAttemptStatus, ToolExecutionReceipt, VerificationStatus,
};
use semi_os_storage::{Storage, StorageError, ToolAttempt, ToolReplayDecision};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub enum ToolExecutionDecision {
    Execute,
    ReuseVerified(ToolExecutionReceipt),
    Reconcile(ToolExecutionReceipt),
}

#[derive(Debug, Error)]
pub enum ToolExecutionError {
    #[error("successful tool receipt requires positive non-model verification")]
    UnverifiedSuccess,
    #[error("unknown tool receipt must be reconciled before retry")]
    ReconciliationRequired,
    #[error("tool receipt has inconsistent result fields")]
    InconsistentReceipt,
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// 保存完整审计回执，并把稳定查询字段投影到 `tool_attempts` 列。
///
/// 领域回执保存在 `receipt_json`，存储模型只是索引投影；这样后续 Tool Registry
/// 可以扩展回执内容，而不需要让 SQLite 行结构成为跨进程公共契约。
pub fn save_execution_receipt(
    storage: &mut Storage,
    receipt: &ToolExecutionReceipt,
) -> Result<(), ToolExecutionError> {
    validate_receipt(receipt)?;
    storage.save_tool_attempt(&receipt_to_attempt(receipt)?)?;
    Ok(())
}

/// 恢复路径必须先调用本函数。`Reconcile` 明确禁止调用真实工具重试。
pub fn decide_execution(
    storage: &Storage,
    task_id: &str,
    idempotency_key: &str,
) -> Result<ToolExecutionDecision, ToolExecutionError> {
    match storage.tool_replay_decision(task_id, idempotency_key)? {
        ToolReplayDecision::Execute => Ok(ToolExecutionDecision::Execute),
        ToolReplayDecision::ReuseCompleted(attempt) => {
            let receipt = receipt_from_attempt(&attempt)?;
            if !receipt.is_verified_success() {
                return Err(ToolExecutionError::UnverifiedSuccess);
            }
            Ok(ToolExecutionDecision::ReuseVerified(receipt))
        }
        ToolReplayDecision::ReconcileIncomplete(attempt) => Ok(ToolExecutionDecision::Reconcile(
            receipt_from_attempt(&attempt)?,
        )),
    }
}

fn validate_receipt(receipt: &ToolExecutionReceipt) -> Result<(), ToolExecutionError> {
    match receipt.status {
        ToolAttemptStatus::Succeeded => {
            if !receipt.is_verified_success()
                || receipt.verification.as_ref().is_none_or(|verification| {
                    verification.method == "model_prose" || verification.evidence.is_empty()
                })
            {
                return Err(ToolExecutionError::UnverifiedSuccess);
            }
        }
        ToolAttemptStatus::Unknown => {
            if receipt.result_type != Some(ResultType::Unknown)
                || receipt
                    .verification
                    .as_ref()
                    .is_some_and(|record| record.status == VerificationStatus::Passed)
            {
                return Err(ToolExecutionError::InconsistentReceipt);
            }
        }
        ToolAttemptStatus::Failed if receipt.result_type != Some(ResultType::Failure) => {
            return Err(ToolExecutionError::InconsistentReceipt);
        }
        ToolAttemptStatus::Cancelled if receipt.result_type != Some(ResultType::Cancelled) => {
            return Err(ToolExecutionError::InconsistentReceipt);
        }
        ToolAttemptStatus::NeedsUser if receipt.result_type != Some(ResultType::NeedsUser) => {
            return Err(ToolExecutionError::InconsistentReceipt);
        }
        ToolAttemptStatus::Started if receipt.result_type.is_some() => {
            return Err(ToolExecutionError::InconsistentReceipt);
        }
        _ => {}
    }

    // 等待确认时还没有 approval binding；只有真正声称已获批准的执行回执
    // 必须绑定审批 ID 和输入摘要，防止审批后更换目标或载荷。
    if receipt.policy_decision == PolicyDecision::Approved && receipt.approval.is_none() {
        return Err(ToolExecutionError::InconsistentReceipt);
    }
    Ok(())
}

fn receipt_to_attempt(receipt: &ToolExecutionReceipt) -> Result<ToolAttempt, serde_json::Error> {
    Ok(ToolAttempt {
        attempt_id: receipt.attempt_id.clone(),
        task_id: receipt.task_id.clone(),
        tool_name: receipt.tool_name.clone(),
        idempotency_key: receipt.idempotency_key.clone(),
        attempt_number: receipt.attempt_number,
        status: receipt.status,
        risk_level: receipt.risk_level,
        input_digest: receipt.input_digest.clone(),
        target: receipt
            .target
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?,
        policy: Some(json!({
            "decision": receipt.policy_decision,
            "approval": receipt.approval,
            "inputSummary": receipt.input_summary
        })),
        result_type: receipt.result_type,
        receipt: Some(serde_json::to_value(receipt)?),
        verification: receipt
            .verification
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?,
        started_at_ms: receipt.started_at_ms,
        finished_at_ms: receipt.finished_at_ms,
    })
}

fn receipt_from_attempt(attempt: &ToolAttempt) -> Result<ToolExecutionReceipt, ToolExecutionError> {
    let value = attempt
        .receipt
        .clone()
        .ok_or(ToolExecutionError::InconsistentReceipt)?;
    Ok(serde_json::from_value(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_protocol::{EvidenceReference, TaskLifecycle, ToolRiskLevel, VerificationRecord};
    use semi_os_storage::{NewTaskEvent, TaskSnapshot};

    fn seed_task(storage: &mut Storage) {
        storage
            .persist_task_event(
                TaskSnapshot {
                    task_id: "task_tool".to_owned(),
                    task_run_id: "run_tool".to_owned(),
                    trace_id: "trace_tool".to_owned(),
                    lifecycle: TaskLifecycle::Created,
                    title: None,
                    current_step: None,
                    checkpoint: None,
                    last_event_sequence: 0,
                    created_at_ms: 1,
                    updated_at_ms: 1,
                },
                NewTaskEvent {
                    event_id: "evt_created".to_owned(),
                    event_kind: "task.lifecycle_changed".to_owned(),
                    payload: json!({}),
                    occurred_at_ms: 1,
                },
            )
            .expect("task should be seeded");
    }

    fn receipt(status: ToolAttemptStatus, result_type: Option<ResultType>) -> ToolExecutionReceipt {
        ToolExecutionReceipt {
            attempt_id: "attempt_01".to_owned(),
            task_id: "task_tool".to_owned(),
            tool_name: "browser_open".to_owned(),
            idempotency_key: "open:example".to_owned(),
            attempt_number: 1,
            status,
            risk_level: ToolRiskLevel::Read,
            input_summary: "打开已脱敏地址".to_owned(),
            input_digest: "sha256:input".to_owned(),
            target: None,
            policy_decision: PolicyDecision::Auto,
            approval: None,
            started_at_ms: 10,
            finished_at_ms: Some(20),
            duration_ms: Some(10),
            result_type,
            output_summary: Some("已打开".to_owned()),
            verification: Some(VerificationRecord {
                status: VerificationStatus::Passed,
                method: "browser_readback".to_owned(),
                summary: "页面地址匹配".to_owned(),
                evidence: vec![EvidenceReference {
                    kind: "browser_page".to_owned(),
                    reference: "page_01".to_owned(),
                }],
                verified_at_ms: Some(20),
            }),
            artifacts: vec![],
        }
    }

    #[test]
    fn requires_positive_verification_for_success() {
        let mut storage = Storage::open_in_memory().expect("storage should open");
        seed_task(&mut storage);
        let mut unverified = receipt(ToolAttemptStatus::Succeeded, Some(ResultType::Success));
        unverified.verification = None;
        assert!(matches!(
            save_execution_receipt(&mut storage, &unverified),
            Err(ToolExecutionError::UnverifiedSuccess)
        ));

        let mut prose_only = receipt(ToolAttemptStatus::Succeeded, Some(ResultType::Success));
        prose_only
            .verification
            .as_mut()
            .expect("verification")
            .method = "model_prose".to_owned();
        assert!(matches!(
            save_execution_receipt(&mut storage, &prose_only),
            Err(ToolExecutionError::UnverifiedSuccess)
        ));
    }

    #[test]
    fn reuses_verified_receipt_after_restart() {
        let mut storage = Storage::open_in_memory().expect("storage should open");
        seed_task(&mut storage);
        let completed = receipt(ToolAttemptStatus::Succeeded, Some(ResultType::Success));
        save_execution_receipt(&mut storage, &completed).expect("receipt should persist");

        assert!(matches!(
            decide_execution(&storage, "task_tool", "open:example").expect("decision should load"),
            ToolExecutionDecision::ReuseVerified(_)
        ));
    }

    #[test]
    fn unknown_attempt_blocks_retry_until_reconciled() {
        let mut storage = Storage::open_in_memory().expect("storage should open");
        seed_task(&mut storage);
        let mut unknown = receipt(ToolAttemptStatus::Unknown, Some(ResultType::Unknown));
        unknown.verification = Some(VerificationRecord {
            status: VerificationStatus::Inconclusive,
            method: "remote_lookup".to_owned(),
            summary: "连接中断，无法确认请求是否生效".to_owned(),
            evidence: vec![],
            verified_at_ms: Some(20),
        });
        save_execution_receipt(&mut storage, &unknown).expect("unknown receipt should persist");

        assert!(matches!(
            decide_execution(&storage, "task_tool", "open:example").expect("decision should load"),
            ToolExecutionDecision::Reconcile(_)
        ));
    }
}
