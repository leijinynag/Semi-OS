//! 桌面跨进程边界：准确参数批准、持久动作阶段与 RPC 去重先于系统派发。
use crate::{
    desktop::DesktopService,
    desktop_macos::{DesktopAction, DesktopDriver},
    HostError, HostResult,
};
use semi_os_protocol::{messages::PayloadDesktopResult, Envelope};
use semi_os_storage::{DesktopActionRecord, Storage};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation_id: String,
    task_id: String,
    attempt_id: String,
    input_json: String,
    input_digest: String,
    approval_id: Option<String>,
    action: DesktopAction,
}

pub fn dispatch<D: DesktopDriver>(
    storage: &mut Storage,
    service: &mut DesktopService<D>,
    message: &Envelope,
    now: i64,
) -> HostResult<PayloadDesktopResult> {
    let Envelope::Event { kind, payload, .. } = message else {
        return Err(HostError::InvalidRequest("expected desktop event".into()));
    };
    if kind != "desktop.request" {
        return Err(HostError::InvalidRequest("expected desktop request".into()));
    }
    let request: Request = serde_json::from_value(payload.clone())?;
    let result = crate::rpc::dispatch(storage, message, now, |storage| {
        let mut input: Value = serde_json::from_str(&request.input_json)?;
        let digest = format!("sha256:{:x}", Sha256::digest(request.input_json.as_bytes()));
        let action = serde_json::to_value(&request.action)?;
        let fields = input
            .as_object_mut()
            .ok_or_else(|| HostError::InvalidRequest("expected input object".into()))?;
        if fields.contains_key("kind") {
            return Err(HostError::InvalidRequest(
                "tool input must not contain action kind".into(),
            ));
        }
        fields.insert("kind".into(), action["kind"].clone());
        if digest != request.input_digest || input != action {
            return Err(HostError::InvalidRequest("desktop input mismatch".into()));
        }
        let mutation = !matches!(request.action, DesktopAction::Observe);
        let tool = format!("desktop_{}", action["kind"].as_str().unwrap_or(""));
        if mutation {
            let approval = request
                .approval_id
                .as_deref()
                .ok_or_else(|| HostError::InvalidRequest("desktop approval required".into()))?;
            if !storage.desktop_approval_matches(
                approval,
                &request.task_id,
                &tool,
                &digest,
                None,
                now,
            )? {
                return Err(HostError::InvalidRequest(
                    "desktop approval expired or already claimed".into(),
                ));
            }
        }
        let mut result = PayloadDesktopResult {
            status: "needs_user".into(),
            summary: "需要用户批准占用桌面，或明确恢复后重新观察".into(),
            lease_generation: 0,
            observation: None,
            evidence: None,
        };
        service.permissions(now as u64);
        // 此阶段每次变更均要求真人批准；后台并不继承总计划作为桌面占用授权。
        if mutation && service.ensure_owner(&request.task_id, true).is_err() {
            return Ok(serde_json::to_value(result)?);
        }
        storage.claim_desktop_action(
            &DesktopActionRecord {
                request_id: request.operation_id.clone(),
                task_id: request.task_id.clone(),
                attempt_id: request.attempt_id.clone(),
                action_kind: tool,
                lease_generation: 0,
                stage: "not_dispatched".into(),
                summary: "Host 已核对参数".into(),
            },
            request.approval_id.as_deref(),
            &digest,
            now,
        )?;
        let authorization = if mutation {
            Some(
                service
                    .authorize_action(&request.task_id, &request.action, true)
                    .map_err(HostError::InvalidRequest)?,
            )
        } else {
            None
        };
        // 先落可能已派发；崩溃恢复只能核对，不能重放。
        if mutation {
            storage.update_desktop_action(
                &request.operation_id,
                "possibly_dispatched",
                0,
                "准备派发原子动作",
                now,
            )?;
        }
        service.begin_operation(&request.task_id, &request.operation_id);
        result = service.execute(
            &request.task_id,
            &request.action,
            authorization.as_ref(),
            now as u64,
        );
        let stage = if result.status == "observed" {
            "verified"
        } else {
            &result.status
        };
        storage.update_desktop_action(
            &request.operation_id,
            stage,
            result.lease_generation,
            &result.summary,
            now,
        )?;
        Ok(serde_json::to_value(result)?)
    })?;
    if !result.result.ok {
        return Err(HostError::InvalidRequest(
            result
                .result
                .error
                .unwrap_or_else(|| "desktop request rejected".into()),
        ));
    }
    Ok(serde_json::from_value(result.result.value.ok_or_else(
        || HostError::InvalidRequest("desktop result missing".into()),
    )?)?)
}
