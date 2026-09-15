//! Shared Rust domain types for the Host/Worker protocol.

mod generated;

pub use generated::*;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeContext {
    pub task_id: Option<TaskId>,
    pub task_run_id: Option<TaskRunId>,
    pub trace_id: Option<TraceId>,
}

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
