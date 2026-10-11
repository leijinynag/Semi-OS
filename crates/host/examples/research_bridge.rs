//! 无 WebView 的验收入口：真实 Worker 协议经过同一 Host 校验并写入 SQLite。
use semi_os_host::research;
use semi_os_protocol::ToolExecutionReceipt;
use semi_os_storage::Storage;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let path = std::env::args().nth(1).expect("SQLite path required");
    let mut storage = Storage::open(path).expect("storage must open");
    for line in io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.expect("stdin read")).expect("JSON input");
        let payload = &value["payload"];
        let result = match value["kind"].as_str() {
            Some("research.persist") => match payload["operation"].as_str() {
                Some("source") => research::save_source(&mut storage, &payload["value"]),
                Some("report") => research::save_report(&mut storage, &payload["value"]),
                Some("policy") => research::validate_policy(&payload["value"]).and_then(|()| {
                    if ["read", "local_write"]
                        .contains(&payload["value"]["riskLevel"].as_str().unwrap_or(""))
                    {
                        Ok(())
                    } else {
                        Err("live acceptance does not authorize external actions".into())
                    }
                }),
                _ => Err("invalid operation".into()),
            },
            Some("research.receipt") => {
                serde_json::from_value::<ToolExecutionReceipt>(payload.clone())
                    .map_err(|e| e.to_string())
                    .and_then(|r| research::save_receipt(&mut storage, &r))
            }
            Some("research.progress") => research::record_progress(
                &mut storage,
                payload["taskId"].as_str().unwrap_or(""),
                payload.clone(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64,
            ),
            Some("voice.turn.completed") => research::finish_turn(
                &mut storage,
                payload["taskId"].as_str().unwrap_or(""),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64,
            ),
            Some("archive") => {
                println!(
                    "{}",
                    json!({"archive":storage.load_research_archive().unwrap()})
                );
                io::stdout().flush().unwrap();
                continue;
            }
            _ => Ok(()),
        };
        println!(
            "{}",
            json!({"operationId":payload["operationId"],"ok":result.is_ok(),"error":result.err()})
        );
        io::stdout().flush().unwrap();
    }
}
