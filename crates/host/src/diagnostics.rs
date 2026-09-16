use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{create_dir_all, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// 可持久化的脱敏诊断记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRecord {
    pub timestamp_ms: u64,
    pub category: String,
    pub message: String,
    pub restart_count: u32,
    pub details: Value,
}

impl DiagnosticRecord {
    pub fn now(
        category: impl Into<String>,
        message: impl Into<String>,
        restart_count: u32,
        details: Value,
    ) -> Self {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            timestamp_ms,
            category: category.into(),
            message: message.into(),
            restart_count,
            details,
        }
    }
}

/// 以 JSONL 追加方式保存 Host 诊断。
///
/// 写入前统一脱敏，避免未来调用方忘记处理 token、API key 或 Authorization
/// 字段。Mutex 保证同一进程内多线程写入不会把两条 JSONL 记录交错。
#[derive(Debug)]
pub struct DiagnosticStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl DiagnosticStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            write_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, record: &DiagnosticRecord) -> io::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| io::Error::other("diagnostic store lock poisoned"))?;
        if let Some(parent) = self.path.parent() {
            create_dir_all(parent)?;
        }

        let sanitized = sanitize_record(record);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        serde_json::to_writer(&mut file, &sanitized)?;
        file.write_all(b"\n")?;
        file.flush()
    }
}

fn sanitize_record(record: &DiagnosticRecord) -> DiagnosticRecord {
    DiagnosticRecord {
        timestamp_ms: record.timestamp_ms,
        category: sanitize_text(&record.category),
        message: sanitize_text(&record.message),
        restart_count: record.restart_count,
        details: sanitize_value(&record.details),
    }
}

fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(sanitize_text(text)),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let sanitized = if is_sensitive_key(key) {
                        Value::String("[REDACTED]".to_owned())
                    } else {
                        sanitize_value(value)
                    };
                    (key.clone(), sanitized)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    normalized.contains("token")
        || normalized.contains("apikey")
        || normalized.contains("secret")
        || normalized.contains("privatekey")
        || normalized.contains("accesskey")
        || matches!(
            normalized.as_str(),
            "authorization" | "password" | "passwd" | "cookie" | "setcookie"
        )
}

fn sanitize_text(text: &str) -> String {
    text.split_whitespace()
        .map(|part| {
            let normalized = part.to_ascii_lowercase();
            if normalized.starts_with("token=")
                || normalized.starts_with("api_key=")
                || normalized.starts_with("apikey=")
                || normalized.starts_with("authorization:")
                || normalized.starts_with("authorization=")
            {
                part.split_once(['=', ':']).map_or_else(
                    || "[REDACTED]".to_owned(),
                    |(key, _)| format!("{key}=[REDACTED]"),
                )
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, process};

    #[test]
    fn appends_jsonl_and_redacts_common_secret_shapes() {
        let path = std::env::temp_dir().join(format!(
            "semi-os-diagnostics-{}-{}.jsonl",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let store = DiagnosticStore::new(&path);
        store
            .append(&DiagnosticRecord::now(
                "worker",
                "authorization:secret token=abc ordinary",
                2,
                json!({
                    "api_key": "key-value",
                    "nested": { "accessToken": "token-value" },
                    "clientSecret": "client-secret-value",
                    "privateKey": "private-key-value",
                    "access-key": "access-key-value",
                    "cookie": "session-cookie-value",
                    "safe": "visible"
                }),
            ))
            .expect("diagnostic record should be written");

        let content = fs::read_to_string(&path).expect("diagnostic file should exist");
        assert!(!content.contains("secret"));
        assert!(!content.contains("abc"));
        assert!(!content.contains("key-value"));
        assert!(!content.contains("token-value"));
        assert!(!content.contains("client-secret-value"));
        assert!(!content.contains("private-key-value"));
        assert!(!content.contains("access-key-value"));
        assert!(!content.contains("session-cookie-value"));
        assert!(content.contains("[REDACTED]"));
        assert!(content.contains("visible"));
        let _ = fs::remove_file(path);
    }
}
