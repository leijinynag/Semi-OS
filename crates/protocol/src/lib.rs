//! Host 与 Agent Worker 之间共享的 Rust 协议类型。
//!
//! 本模块位于进程信任边界：反序列化只负责恢复结构，业务代码在使用消息前
//! 还必须调用 [`validate_envelope`] 检查协议版本和领域约束。

mod domain;
mod generated;
mod receipt;

pub use domain::*;
pub use generated::*;
pub use receipt::*;

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
    let (protocol_version, request_id, kind, is_error) = match envelope {
        Envelope::Request {
            protocol_version,
            request_id,
            kind,
            ..
        }
        | Envelope::Response {
            protocol_version,
            request_id,
            kind,
            ..
        }
        | Envelope::Event {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, false),
        Envelope::Error {
            protocol_version,
            request_id,
            kind,
            ..
        } => (*protocol_version, request_id, kind, true),
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

    Ok(())
}

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
}
