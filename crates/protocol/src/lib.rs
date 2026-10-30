//! Host 与 Agent Worker 之间共享的 Rust 协议类型。
//!
//! 本模块位于进程信任边界：反序列化只负责恢复结构，业务代码在使用消息前
//! 还必须调用 [`validate_envelope`] 检查协议版本和领域约束。

mod domain;
mod generated;
mod receipt;
mod workflow;

pub use domain::*;
pub use generated::*;
pub use receipt::*;
pub use workflow::*;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Host 与 Agent Worker 当前共同支持的协议版本。
///
/// 不支持的版本必须被拒绝，不能按相似结构继续执行。
pub const PROTOCOL_VERSION: u8 = 1;

/// 可选的任务追踪上下文。
///
/// `request_id` 位于具体信封中；这里的字段把单次请求关联到任务、执行轮次
/// 和端到端调用链。`None` 不序列化，以保持 JSONL 消息紧凑。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_run_id: Option<TaskRunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<TraceId>,
}

/// 跨进程 JSONL 信封。
///
/// `direction` 是 serde 的内部标签；字段命名必须与 TypeScript 实现保持一致，
/// 任何结构调整都应先修改 Schema，再重新生成类型并运行共享契约测试。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "direction")]
pub enum Envelope {
    #[serde(rename = "request")]
    Request {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "requestId")]
        request_id: RequestId,
        kind: String,
        payload: Value,
        #[serde(flatten)]
        context: EnvelopeContext,
    },
    #[serde(rename = "response")]
    Response {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "requestId")]
        request_id: RequestId,
        kind: String,
        payload: Value,
        #[serde(flatten)]
        context: EnvelopeContext,
    },
    #[serde(rename = "event")]
    Event {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "requestId")]
        request_id: RequestId,
        kind: String,
        payload: Value,
        #[serde(flatten)]
        context: EnvelopeContext,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "requestId")]
        request_id: RequestId,
        kind: String,
        payload: ErrorPayload,
        #[serde(flatten)]
        context: EnvelopeContext,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolValidationError {
    pub code: &'static str,
    pub message: String,
}

/// 校验反序列化后仍需满足的协议语义。
///
/// serde 可以保证基本字段类型，但无法表达当前版本支持范围、ID 前缀和
/// error kind 白名单，因此消息进入 Host 业务逻辑前必须调用本函数。
pub fn validate_envelope(envelope: &Envelope) -> Result<(), ProtocolValidationError> {
    let (protocol_version, request_id, kind, direction, is_error) = match envelope {
        Envelope::Request {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, "request", false),
        Envelope::Response {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, "response", false),
        Envelope::Event {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, "event", false),
        Envelope::Error {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, "error", true),
    };

    if protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolValidationError {
            code: "unsupported_version",
            message: format!("Unsupported protocol version: {protocol_version}"),
        });
    }
    if !matches_id(&request_id.0, "req_") {
        return Err(ProtocolValidationError {
            code: "invalid_field",
            message: "requestId has an invalid format".to_owned(),
        });
    }
    if kind.is_empty() {
        return Err(ProtocolValidationError {
            code: "invalid_field",
            message: "kind must be a non-empty string".to_owned(),
        });
    }
    if is_error && !matches!(kind.as_str(), "protocol.error" | "request.error") {
        return Err(ProtocolValidationError {
            code: "invalid_field",
            message: "error kind is invalid".to_owned(),
        });
    }
    if !is_error {
        let shape =
            registered_message_shape(direction, kind).ok_or_else(|| ProtocolValidationError {
                code: "unsupported_kind",
                message: format!("Unsupported {direction} message kind: {kind}"),
            })?;
        let payload = match envelope {
            Envelope::Request { payload, .. }
            | Envelope::Response { payload, .. }
            | Envelope::Event { payload, .. } => payload,
            Envelope::Error { .. } => unreachable!("error envelopes are excluded above"),
        };
        if matches!(
            kind.as_str(),
            "workflow.request" | "research.persist" | "desktop.request"
        ) && payload["operationId"].as_str() != Some(request_id.0.as_str())
        {
            return Err(ProtocolValidationError {
                code: "invalid_payload",
                message: "operationId must match requestId".into(),
            });
        }
        let valid_shape = match shape {
            PayloadShape::Object => payload.is_object(),
            PayloadShape::ObjectOrNull => payload.is_object() || payload.is_null(),
        };
        if !valid_shape {
            return Err(ProtocolValidationError {
                code: "invalid_payload",
                message: format!("{direction} message {kind} has an invalid payload shape"),
            });
        }
    }

    // 只编译本地生成的 Schema；关闭网络/文件解析，外部输入不能加载新规则。
    static VALIDATOR: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(
            &serde_json::from_str(include_str!("wire.schema.generated.json"))
                .expect("generated schema must be valid JSON"),
        )
        .expect("generated protocol schema must compile")
    });
    let value = serde_json::to_value(envelope).map_err(|_| ProtocolValidationError {
        code: "invalid_payload",
        message: "Cannot encode protocol message".into(),
    })?;
    validator
        .validate(&value)
        .map_err(|_| ProtocolValidationError {
            code: "invalid_payload",
            message: format!("Invalid {kind} payload or context"),
        })?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadShape {
    Object,
    ObjectOrNull,
}

include!("registry.generated.rs");

// ID 前缀用于区分领域对象；后缀限制为便于日志、SQLite 和 JSON 传输的字符集。
fn matches_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '-'
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_fixture_request() {
        // 与 Node 测试共享 Fixture，防止两端字段名或序列化格式悄悄漂移。
        let fixture = include_str!("../../../tests/contract/fixtures/request.json");
        let envelope: Envelope = serde_json::from_str(fixture).expect("fixture should deserialize");
        validate_envelope(&envelope).expect("fixture should validate");
    }

    #[test]
    fn accepts_a_null_payload_for_a_nullable_object_response() {
        // browser.session.snapshot 在没有接管状态时合法返回 null。schema 用
        // `oneOf: [null, ...]` 表达可空性，registry 必须与 `type: ["object","null"]`
        // 同等对待，否则 Worker 会被误判成非法载荷并进入重启循环。
        let message = serde_json::json!({
            "protocolVersion": 1,
            "direction": "response",
            "requestId": "req_nullableSnapshot",
            "kind": "browser.session.snapshot",
            "payload": null
        });
        let envelope: Envelope =
            serde_json::from_value(message).expect("envelope should deserialize");
        validate_envelope(&envelope).expect("null snapshot payload should be accepted");
    }

    #[test]
    fn shares_field_level_positive_and_negative_contracts_with_node() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/payload-cases.json"
        ))
        .unwrap();
        for case in cases {
            let result = serde_json::from_value::<Envelope>(case["message"].clone())
                .map_err(|error| error.to_string())
                .and_then(|envelope| validate_envelope(&envelope).map_err(|error| error.message));
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {:?}",
                case["name"],
                result
            );
            if case["valid"] == true {
                // wire 校验与生成 DTO 必须兼容，不能只有 schema 通过而类型解码失败。
                let value = case["message"].clone();
                if value["direction"] == "request" {
                    serde_json::from_value::<crate::messages::RequestMessage>(value).unwrap();
                } else {
                    serde_json::from_value::<crate::messages::EventMessage>(value).unwrap();
                }
            }
        }
    }

    #[test]
    fn rejects_unknown_protocol_version() {
        let envelope = Envelope::Request {
            protocol_version: 99,
            request_id: RequestId("req_test".to_owned()),
            kind: "health.check".to_owned(),
            payload: Value::Null,
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert_eq!(
            validate_envelope(&envelope)
                .expect_err("version must fail")
                .code,
            "unsupported_version"
        );
    }

    #[test]
    fn rejects_unknown_kind_and_invalid_payload_shape() {
        let unknown = Envelope::Request {
            protocol_version: PROTOCOL_VERSION,
            request_id: RequestId("req_unknown".to_owned()),
            kind: "unknown.request".to_owned(),
            payload: serde_json::json!({}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert_eq!(
            validate_envelope(&unknown)
                .expect_err("unknown kind must fail")
                .code,
            "unsupported_kind"
        );

        let malformed = Envelope::Request {
            protocol_version: PROTOCOL_VERSION,
            request_id: RequestId("req_malformed".to_owned()),
            kind: "voice.text.submit".to_owned(),
            payload: serde_json::json!("not-an-object"),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert_eq!(
            validate_envelope(&malformed)
                .expect_err("payload shape must fail")
                .code,
            "invalid_payload"
        );
    }
}
/// 字段 DTO 与消息判别联合由同一 Schema 生成，不能手写第二套 wire 契约。
#[path = "messages.generated.rs"]
pub mod messages;
