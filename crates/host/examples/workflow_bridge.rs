//! 合成仓库验收桥：使用真实 Host/SQLite；approve 仅供测试模拟独立用户命令。
//! 不进入产品 Worker 协议，不提供通用外部权限批准。
use semi_os_host::workflow;
use semi_os_protocol::{Envelope, EnvelopeContext, RequestId};
use semi_os_storage::Storage;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn handle(
    storage: &mut Storage,
    operation: &str,
    value: &Value,
    request_id: &str,
    now: i64,
) -> Result<Value, String> {
    let text = |key: &str| value[key].as_str().ok_or_else(|| format!("missing {key}"));
    match operation {
        "session" => storage
            .create_client_session(text("sessionId")?, "合成协作", now)
            .map(|_| json!({"created":true}))
            .map_err(|e| e.to_string()),
        "approve" => storage
            .decide_workflow(
                text("workflowId")?,
                value["version"].as_u64().ok_or("version")? as u32,
                text("digest")?,
                "approved",
                now,
            )
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|e| e.to_string()),
        _ => {
            let id = format!("req_bridge_{request_id}");
            let message = Envelope::Event {
                protocol_version: 1,
                request_id: RequestId(id.clone()),
                kind: "workflow.request".into(),
                payload: json!({"operationId":id,"operation":operation,"value":value}),
                context: EnvelopeContext {
                    task_id: None,
                    task_run_id: None,
                    trace_id: None,
                },
            };
            let result = workflow::dispatch_request(storage, &message, now)
                .map_err(|error| error.ui_message().to_string())?
                .result;
            if result.ok {
                Ok(result.value.unwrap_or(Value::Null))
            } else {
                Err(result.error.unwrap_or_else(|| "Host request failed".into()))
            }
        }
    }
}
fn main() {
    let mut storage =
        Storage::open(std::env::args().nth(1).expect("SQLite path")).expect("open storage");
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.expect("read input")).expect("JSON");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let request_id = match &request["id"] {
            Value::String(id) => id.clone(),
            Value::Number(id) => id.to_string(),
            _ => "invalid".into(),
        };
        let result = handle(
            &mut storage,
            request["operation"].as_str().unwrap_or(""),
            &request["value"],
            &request_id,
            now,
        );
        println!(
            "{}",
            json!({"id":request["id"],"ok":result.is_ok(),"value":result.as_ref().ok(),"error":result.as_ref().err()})
        );
        io::stdout().flush().unwrap();
    }
}
