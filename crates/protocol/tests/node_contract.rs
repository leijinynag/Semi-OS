use semi_os_protocol::{validate_envelope, Envelope};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

/// 同一组消息穿过真实 Node 校验器，再经 Rust 解码；子进程隔离且有界退出。
#[test]
fn rust_and_node_agree_on_jsonl_contracts() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .args([
            "--experimental-strip-types",
            "tests/contract/fixtures/validated-worker.mjs",
        ])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("Node runtime required for contract tests");
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/contract/fixtures/payload-cases.json"
    ))
    .unwrap();
    cases.push(serde_json::json!({"name":"broken JSON","valid":false,"raw":"{broken"}));
    // 使用闭包确保断言前也回收子进程；失败不能留下卡在 stdin 的 Fixture。
    let result = (|| -> Result<(), String> {
        for case in cases {
            let raw = case["raw"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| case["message"].to_string());
            writeln!(input, "{raw}").map_err(|error| error.to_string())?;
            input.flush().map_err(|error| error.to_string())?;
            let line = rx
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| format!("{}: {error}", case["name"]))?
                .map_err(|error| error.to_string())?;
            let envelope: Envelope =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            validate_envelope(&envelope).map_err(|error| error.message)?;
            let valid = case["valid"].as_bool().unwrap();
            if valid {
                if serde_json::to_value(envelope).unwrap() != case["message"] {
                    return Err(format!("{}: round trip changed the message", case["name"]));
                }
            } else if !matches!(envelope, Envelope::Error { .. }) {
                return Err(format!("{}: malformed message was accepted", case["name"]));
            }
        }
        Ok(())
    })();
    drop(input);
    let _ = child.kill();
    let _ = child.wait();
    reader.join().unwrap();
    result.expect("Node/Rust contract agreement");
}
