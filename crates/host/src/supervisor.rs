use crate::{DiagnosticRecord, DiagnosticStore};
use semi_os_protocol::{validate_envelope, Envelope, EnvelopeContext, RequestId, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// 启动 Worker 所需的可执行文件、参数和工作目录。
#[derive(Debug, Clone)]
pub struct WorkerCommand {
    pub program: String,
    pub args: Vec<String>,
    pub current_dir: PathBuf,
}

/// 有限指数退避策略；`max_restarts` 不包含第一次启动。
#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
    pub max_restarts: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub health_timeout: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 3,
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(2),
            health_timeout: Duration::from_secs(3),
        }
    }
}

/// 可安全发送到 UI 的 Worker 结构化事件。
///
/// 事件只包含生命周期元数据，不携带原始 stderr、环境变量或 Provider
/// Payload；深入排障使用 Host 持久化且已脱敏的诊断文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerEvent {
    Starting {
        restart_count: u32,
    },
    Ready {
        pid: u32,
        restart_count: u32,
    },
    ProtocolError {
        message: String,
        restart_count: u32,
    },
    Exited {
        code: Option<i32>,
        restart_count: u32,
    },
    RestartScheduled {
        restart_count: u32,
        delay_ms: u64,
    },
    RestartLimitReached {
        restart_count: u32,
    },
    Stopped,
}

pub type WorkerEventHandler = Arc<dyn Fn(WorkerEvent) + Send + Sync + 'static>;
pub type WorkerMessageHandler = Arc<dyn Fn(Envelope) + Send + Sync + 'static>;

pub struct WorkerSupervisor {
    command: WorkerCommand,
    restart_policy: RestartPolicy,
    diagnostics: Arc<DiagnosticStore>,
    event_handler: WorkerEventHandler,
    message_handler: WorkerMessageHandler,
}

impl WorkerSupervisor {
    pub fn new(
        command: WorkerCommand,
        restart_policy: RestartPolicy,
        diagnostics: Arc<DiagnosticStore>,
        event_handler: WorkerEventHandler,
        message_handler: WorkerMessageHandler,
    ) -> Self {
        Self {
            command,
            restart_policy,
            diagnostics,
            event_handler,
            message_handler,
        }
    }

    /// 在专用线程中启动监督循环，避免阻塞 Tauri 事件循环。
    pub fn start(self) -> WorkerSupervisorHandle {
        let (stop_tx, stop_rx) = mpsc::channel();
        let join_handle = thread::spawn(move || self.run(stop_rx));
        WorkerSupervisorHandle {
            stop_tx: Some(stop_tx),
            join_handle: Some(join_handle),
        }
    }

    fn run(self, stop_rx: Receiver<()>) {
        let mut restart_count = 0;

        loop {
            if stop_requested(&stop_rx) {
                self.publish(WorkerEvent::Stopped);
                return;
            }

            self.publish(WorkerEvent::Starting { restart_count });
            let outcome = match self.spawn_and_monitor(&stop_rx, restart_count) {
                Ok(outcome) => outcome,
                Err(error) => {
                    self.record(
                        "worker_spawn",
                        "Agent Worker 启动失败",
                        restart_count,
                        json!({ "error": error.to_string() }),
                    );
                    MonitorOutcome::Exited(None)
                }
            };

            match outcome {
                MonitorOutcome::Stopped => {
                    self.publish(WorkerEvent::Stopped);
                    return;
                }
                MonitorOutcome::Exited(code) => {
                    self.publish(WorkerEvent::Exited {
                        code,
                        restart_count,
                    });
                    self.record(
                        "worker_exit",
                        "Agent Worker 已退出",
                        restart_count,
                        json!({ "exitCode": code }),
                    );
                }
                MonitorOutcome::ProtocolError(message) => {
                    self.publish(WorkerEvent::ProtocolError {
                        message: message.clone(),
                        restart_count,
                    });
                    self.record(
                        "worker_protocol",
                        "Agent Worker 协议错误",
                        restart_count,
                        json!({ "error": message }),
                    );
                }
            }

            if restart_count >= self.restart_policy.max_restarts {
                self.publish(WorkerEvent::RestartLimitReached { restart_count });
                return;
            }

            restart_count += 1;
            let delay = backoff_delay(self.restart_policy, restart_count);
            self.publish(WorkerEvent::RestartScheduled {
                restart_count,
                delay_ms: delay.as_millis() as u64,
            });
            self.record(
                "worker_restart",
                "计划重启 Agent Worker",
                restart_count,
                json!({ "delayMs": delay.as_millis() }),
            );
            if wait_or_stop(&stop_rx, delay) {
                self.publish(WorkerEvent::Stopped);
                return;
            }
        }
    }

    fn spawn_and_monitor(
        &self,
        stop_rx: &Receiver<()>,
        restart_count: u32,
    ) -> io::Result<MonitorOutcome> {
        let mut child = Command::new(&self.command.program)
            .args(&self.command.args)
            .current_dir(&self.command.current_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let request_id = RequestId(format!("req_worker_health_{restart_count}"));
        let health_request = Envelope::Request {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            kind: "health.check".to_owned(),
            payload: json!({ "includeCapabilities": false }),
            context: empty_context(),
        };
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("worker stdin unavailable"))?;
        serde_json::to_writer(&mut stdin, &health_request)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("worker stdout unavailable"))?;
        let (line_tx, line_rx) = mpsc::channel();
        let stdout_thread = spawn_line_reader(stdout, line_tx);
        let stderr_thread = child.stderr.take().map(spawn_stderr_drain);

        let handshake = self.wait_for_health(&mut child, stop_rx, &line_rx, &request_id);
        let outcome = match handshake {
            Ok(HandshakeOutcome::Ready(pid)) => {
                self.publish(WorkerEvent::Ready { pid, restart_count });
                monitor_ready_child(&mut child, stop_rx, &line_rx, self.message_handler.as_ref())?
            }
            Ok(HandshakeOutcome::Stopped) => MonitorOutcome::Stopped,
            Err(message) => {
                terminate_child(&mut child);
                MonitorOutcome::ProtocolError(message)
            }
        };

        drop(stdin);
        let _ = stdout_thread.join();
        if let Some(handle) = stderr_thread {
            let _ = handle.join();
        }
        Ok(outcome)
    }

    fn wait_for_health(
        &self,
        child: &mut Child,
        stop_rx: &Receiver<()>,
        line_rx: &Receiver<String>,
        request_id: &RequestId,
    ) -> Result<HandshakeOutcome, String> {
        let deadline = Instant::now() + self.restart_policy.health_timeout;
        loop {
            if stop_requested(stop_rx) {
                terminate_child(child);
                return Ok(HandshakeOutcome::Stopped);
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "worker exited before health.ready: {}",
                    format_exit_status(status)
                ));
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("health.ready timed out".to_owned());
            }
            match line_rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
                Ok(line) => return parse_health_ready(&line, request_id),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("worker stdout closed before health.ready".to_owned());
                }
            }
        }
    }

    fn publish(&self, event: WorkerEvent) {
        (self.event_handler)(event);
    }

    fn record(&self, category: &str, message: &str, restart_count: u32, details: Value) {
        // 诊断写入失败不能让监督线程崩溃；MVP 先保留 stderr 提示，后续接入
        // Host 自身健康状态后再把存储降级暴露给客户端。
        if let Err(error) = self.diagnostics.append(&DiagnosticRecord::now(
            category,
            message,
            restart_count,
            details,
        )) {
            eprintln!("failed to persist worker diagnostic: {error}");
        }
    }
}

pub struct WorkerSupervisorHandle {
    stop_tx: Option<Sender<()>>,
    join_handle: Option<JoinHandle<()>>,
}

impl WorkerSupervisorHandle {
    /// 幂等停止：通知监督线程、终止当前子进程并等待清理完成。
    pub fn stop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }
}

impl Drop for WorkerSupervisorHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

enum MonitorOutcome {
    Stopped,
    Exited(Option<i32>),
    ProtocolError(String),
}

enum HandshakeOutcome {
    Ready(u32),
    Stopped,
}

fn empty_context() -> EnvelopeContext {
    EnvelopeContext {
        task_id: None,
        task_run_id: None,
        trace_id: None,
    }
}

fn parse_health_ready(
    line: &str,
    expected_request_id: &RequestId,
) -> Result<HandshakeOutcome, String> {
    let envelope: Envelope =
        serde_json::from_str(line).map_err(|error| format!("invalid JSONL: {error}"))?;
    validate_envelope(&envelope).map_err(|error| error.message)?;

    match envelope {
        Envelope::Response {
            request_id,
            kind,
            payload,
            ..
        } if request_id == *expected_request_id && kind == "health.ready" => {
            let pid = payload
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "health.ready payload.pid is invalid".to_owned())?;
            Ok(HandshakeOutcome::Ready(pid))
        }
        _ => Err("expected matching health.ready response".to_owned()),
    }
}

/// Worker 就绪后继续消费 stdout，避免协议消息堆积，并保证所有跨进程消息在
/// 进入上层前都经过 JSON 反序列化与版本校验。
fn monitor_ready_child(
    child: &mut Child,
    stop_rx: &Receiver<()>,
    line_rx: &Receiver<String>,
    message_handler: &dyn Fn(Envelope),
) -> io::Result<MonitorOutcome> {
    loop {
        if stop_requested(stop_rx) {
            terminate_child(child);
            return Ok(MonitorOutcome::Stopped);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(MonitorOutcome::Exited(status.code()));
        }
        match line_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(line) => match parse_worker_message(&line) {
                Ok(envelope) => message_handler(envelope),
                Err(message) => {
                    terminate_child(child);
                    return Ok(MonitorOutcome::ProtocolError(message));
                }
            },
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return classify_closed_stdout(child),
        }
    }
}

fn classify_closed_stdout(child: &mut Child) -> io::Result<MonitorOutcome> {
    // 子进程退出时 stdout 管道和退出状态不是原子可见的；给操作系统一个很短
    // 的有界窗口刷新状态，避免把正常崩溃误记为协议错误。
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(MonitorOutcome::Exited(status.code()));
        }
        if Instant::now() >= deadline {
            terminate_child(child);
            return Ok(MonitorOutcome::ProtocolError(
                "worker stdout closed while process was running".to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn parse_worker_message(line: &str) -> Result<Envelope, String> {
    let envelope: Envelope =
        serde_json::from_str(line).map_err(|error| format!("invalid JSONL: {error}"))?;
    validate_envelope(&envelope).map_err(|error| error.message)?;
    Ok(envelope)
}

fn spawn_line_reader(
    stdout: impl io::Read + Send + 'static,
    sender: Sender<String>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_stderr_drain(stderr: impl io::Read + Send + 'static) -> JoinHandle<()> {
    thread::spawn(move || {
        // 原始 stderr 可能包含 Provider 响应或凭证，只负责排空管道，绝不向
        // UI 转发。后续 Worker 应通过结构化、可脱敏事件报告可见错误。
        for line in BufReader::new(stderr).lines() {
            if line.is_err() {
                break;
            }
        }
    })
}

fn terminate_child(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        _ => {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn stop_requested(stop_rx: &Receiver<()>) -> bool {
    match stop_rx.try_recv() {
        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => true,
        Err(mpsc::TryRecvError::Empty) => false,
    }
}

fn wait_or_stop(stop_rx: &Receiver<()>, duration: Duration) -> bool {
    match stop_rx.recv_timeout(duration) {
        Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
        Err(RecvTimeoutError::Timeout) => false,
    }
}

fn backoff_delay(policy: RestartPolicy, restart_count: u32) -> Duration {
    let exponent = restart_count.saturating_sub(1).min(31);
    let multiplier = 1_u32 << exponent;
    policy
        .initial_backoff
        .saturating_mul(multiplier)
        .min(policy.max_backoff)
}

fn format_exit_status(status: ExitStatus) -> String {
    status.code().map_or_else(
        || "terminated by signal".to_owned(),
        |code| format!("code {code}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs, process,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn restarts_a_worker_that_crashes_after_ready_and_persists_diagnostics() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/contract/fixtures/crashing-worker.mjs");
        let diagnostics_path = std::env::temp_dir().join(format!(
            "semi-os-supervisor-{}-{}.jsonl",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let supervisor = WorkerSupervisor::new(
            WorkerCommand {
                program: "node".to_owned(),
                args: vec![fixture.to_string_lossy().into_owned()],
                current_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            },
            RestartPolicy {
                max_restarts: 1,
                initial_backoff: Duration::from_millis(10),
                max_backoff: Duration::from_millis(10),
                health_timeout: Duration::from_secs(1),
            },
            Arc::new(DiagnosticStore::new(&diagnostics_path)),
            Arc::new(move |event| {
                captured_events
                    .lock()
                    .expect("event list lock should work")
                    .push(event);
            }),
            Arc::new(|_| {}),
        );
        let mut handle = supervisor.start();

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if events
                .lock()
                .expect("event list lock should work")
                .iter()
                .any(|event| matches!(event, WorkerEvent::RestartLimitReached { .. }))
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        handle.stop();

        let events = events.lock().expect("event list lock should work");
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Ready {
                restart_count: 0,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::Exited {
                code: Some(23),
                restart_count: 0
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            WorkerEvent::RestartScheduled {
                restart_count: 1,
                ..
            }
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event, WorkerEvent::RestartLimitReached { restart_count: 1 })));

        let diagnostics =
            fs::read_to_string(&diagnostics_path).expect("diagnostics should be persisted");
        assert!(diagnostics.contains("\"category\":\"worker_exit\""));
        assert!(diagnostics.contains("\"exitCode\":23"));
        assert!(diagnostics.contains("\"restartCount\":1"));
        let _ = fs::remove_file(diagnostics_path);
    }

    #[test]
    fn consumes_and_validates_messages_after_health_ready() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/contract/fixtures/streaming-worker.mjs");
        let diagnostics_path = std::env::temp_dir().join(format!(
            "semi-os-streaming-worker-{}-{}.jsonl",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured_messages = Arc::clone(&messages);
        let supervisor = WorkerSupervisor::new(
            WorkerCommand {
                program: "node".to_owned(),
                args: vec![fixture.to_string_lossy().into_owned()],
                current_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            },
            RestartPolicy {
                max_restarts: 0,
                initial_backoff: Duration::from_millis(10),
                max_backoff: Duration::from_millis(10),
                health_timeout: Duration::from_secs(1),
            },
            Arc::new(DiagnosticStore::new(&diagnostics_path)),
            Arc::new(|_| {}),
            Arc::new(move |message| {
                captured_messages
                    .lock()
                    .expect("message list lock should work")
                    .push(message);
            }),
        );
        let mut handle = supervisor.start();

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !messages
                .lock()
                .expect("message list lock should work")
                .is_empty()
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        handle.stop();

        let messages = messages.lock().expect("message list lock should work");
        assert!(messages.iter().any(|message| matches!(
            message,
            Envelope::Event { kind, .. } if kind == "worker.progress"
        )));
        let _ = fs::remove_file(diagnostics_path);
    }
}
