use crate::{HostError, HostResult};
use semi_os_protocol::{validate_envelope, Envelope};
use semi_os_storage::{RpcDispatchDecision, RpcResult, Storage};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub struct RpcDispatchResult {
    pub result: RpcResult,
    pub replayed: bool,
}

/// Host RPC 幂等边界。业务工具不负责去重，可能已生效的结果绝不自动重放。
/// 错误也保存安全回执；若在执行/落盘窗口崩溃，下一次领取必须先对账。
pub fn dispatch(
    storage: &mut Storage,
    envelope: &Envelope,
    now: i64,
    operation: impl FnOnce(&mut Storage) -> HostResult<Value>,
) -> HostResult<RpcDispatchResult> {
    validate_envelope(envelope).map_err(|error| HostError::InvalidRequest(error.message))?;
    let (id, kind, digest, version) = request_identity(envelope)?;
    match storage.claim_rpc(&id, &kind, &digest, version, now)? {
        RpcDispatchDecision::Replay(result) => Ok(RpcDispatchResult {
            result,
            replayed: true,
        }),
        RpcDispatchDecision::Execute => {
            let result = match operation(storage) {
                Ok(value) => RpcResult {
                    ok: true,
                    value: Some(value),
                    error: None,
                },
                Err(error) => RpcResult {
                    ok: false,
                    value: None,
                    error: Some(error.ui_message().into()),
                },
            };
            storage.finish_rpc(&id, &result, now)?;
            Ok(RpcDispatchResult {
                result,
                replayed: false,
            })
        }
    }
}

/// 入站与出站共用规范身份，避免字段顺序或上下文差异绕过去重。
pub(crate) fn request_identity(envelope: &Envelope) -> HostResult<(String, String, String, u32)> {
    let value = serde_json::to_value(envelope)?;
    let id = value["requestId"]
        .as_str()
        .ok_or_else(|| HostError::InvalidRequest("missing request id".into()))?;
    let kind = value["kind"]
        .as_str()
        .ok_or_else(|| HostError::InvalidRequest("missing kind".into()))?;
    // 显式递归排序，不依赖 serde_json 的 preserve_order feature；身份包含上下文与方向。
    let mut identity = value.clone();
    identity
        .as_object_mut()
        .expect("serialized envelope")
        .remove("requestId");
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&canonicalize(identity))?)
    );
    let version = value["protocolVersion"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| HostError::InvalidRequest("invalid version".into()))?;
    Ok((id.into(), kind.into(), digest, version))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_protocol::{EnvelopeContext, RequestId};
    use serde_json::json;
    #[test]
    fn duplicate_requests_do_not_execute_again_and_changed_payload_conflicts() {
        let mut storage = Storage::open_in_memory().unwrap();
        let mut envelope = Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_once".into()),
            kind: "workflow.request".into(),
            payload: json!({"operationId":"req_once","operation":"find","value":{}}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        let first = dispatch(&mut storage, &envelope, 1, |_| Ok(json!({"calls":1}))).unwrap();
        let replay = dispatch(&mut storage, &envelope, 2, |_| {
            panic!("must not execute twice")
        })
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.result, first.result);
        if let Envelope::Event { payload, .. } = &mut envelope {
            payload["value"]["name"] = json!("changed");
        }
        assert!(dispatch(&mut storage, &envelope, 3, |_| panic!("digest conflict")).is_err());
    }
}
