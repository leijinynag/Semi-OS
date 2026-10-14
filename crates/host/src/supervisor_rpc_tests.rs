use super::*;
use semi_os_storage::{OutboundStatus, Storage};
use std::{fs, sync::Mutex, time::SystemTime};

fn request() -> Envelope {
    Envelope::Request {
        protocol_version: PROTOCOL_VERSION,
        request_id: RequestId("req_outbound_fixture".into()),
        kind: "workflow.control".into(),
        payload: json!({
            "workflowId": "workflow_fixture",
            "sessionId": "session_fixture",
            "action": "observe"
        }),
        context: empty_context(),
    }
}

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "semi-os-rpc-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(Instant::now() < deadline, "supervisor fixture timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn actual_pipe_deduplicates_and_preserves_unknown_requests_after_restart() {
    for mode in ["ack", "crash"] {
        let directory = temp_dir();
        let database = directory.join("receipts.sqlite");
        let record = directory.join("executions.txt");
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let supervisor = WorkerSupervisor::new(
            WorkerCommand {
                program: "node".into(),
                args: vec![
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../tests/contract/fixtures/outbound-worker.mjs")
                        .to_string_lossy()
                        .into_owned(),
                    record.to_string_lossy().into_owned(),
                    mode.into(),
                ],
                current_dir: directory.clone(),
                environment: vec![],
            },
            RestartPolicy {
                max_restarts: 1,
                initial_backoff: Duration::from_millis(10),
                max_backoff: Duration::from_millis(10),
                health_timeout: Duration::from_secs(2),
            },
            Arc::new(DiagnosticStore::new(directory.join("diagnostics.jsonl"))),
            Arc::new(move |event| captured.lock().unwrap().push(event)),
            Arc::new(|_| {}),
        )
        .with_receipts(&database)
        .unwrap();
        // 在启动前排队，确定性地覆盖相同请求两次入队的竞态。
        let ledger = supervisor.ledger.as_ref().unwrap().clone();
        assert!(ledger.queue(&request()).unwrap());
        assert!(!ledger.queue(&request()).unwrap());
        let mut handle = supervisor.start();
        handle
            .command_tx
            .as_ref()
            .unwrap()
            .send(SupervisorCommand::Send(Box::new(request())))
            .unwrap();
        let expected = if mode == "crash" {
            OutboundStatus::Reconciliation
        } else {
            OutboundStatus::Acknowledged
        };
        let db = Storage::open(&database).unwrap();
        wait_for(|| {
            db.load_outbound_rpc("req_outbound_fixture")
                .unwrap()
                .is_some_and(|receipt| receipt.status == expected)
        });
        if mode == "crash" {
            wait_for(|| {
                events.lock().unwrap().iter().any(|event| {
                    matches!(
                        event,
                        WorkerEvent::Ready {
                            restart_count: 1,
                            ..
                        }
                    )
                })
            });
        }
        assert!(handle.send(request()).is_err());
        handle.stop();
        assert_eq!(
            fs::read_to_string(&record).unwrap(),
            "req_outbound_fixture\n"
        );
        assert_eq!(
            db.load_outbound_rpc("req_outbound_fixture")
                .unwrap()
                .unwrap()
                .status,
            expected
        );
        drop(db);
        drop(handle);
        drop(ledger);
        let _ = fs::remove_dir_all(directory);
    }
}

#[test]
fn partial_write_is_persisted_before_bytes_and_requires_reconciliation() {
    struct PartialWriter {
        database: PathBuf,
        bytes: usize,
    }
    impl Write for PartialWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            let db = Storage::open(&self.database).unwrap();
            assert_eq!(
                db.load_outbound_rpc("req_outbound_fixture")
                    .unwrap()
                    .unwrap()
                    .status,
                OutboundStatus::Sending
            );
            if self.bytes > 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "fixture partial write",
                ));
            }
            self.bytes = buffer.len().min(8);
            Ok(self.bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let directory = temp_dir();
    let database = directory.join("receipts.sqlite");
    {
        let ledger = OutboundLedger::open(&database).unwrap();
        ledger.queue(&request()).unwrap();
        let mut writer = PartialWriter {
            database: database.clone(),
            bytes: 0,
        };
        assert!(send_envelope(&mut writer, &request(), Some(&ledger)).is_err());
        assert!(writer.bytes > 0);
    }
    let ledger = OutboundLedger::open(&database).unwrap();
    assert!(ledger.queue(&request()).is_err());
    let db = Storage::open(&database).unwrap();
    assert_eq!(
        db.load_outbound_rpc("req_outbound_fixture")
            .unwrap()
            .unwrap()
            .status,
        OutboundStatus::Reconciliation
    );
    drop(db);
    drop(ledger);
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn failed_enqueue_releases_receipt_and_invalid_ack_cannot_commit() {
    let directory = temp_dir();
    let database = directory.join("receipts.sqlite");
    let ledger = Arc::new(OutboundLedger::open(&database).unwrap());
    let (sender, receiver) = mpsc::channel();
    drop(receiver);
    let handle = WorkerSupervisorHandle {
        command_tx: Some(sender),
        join_handle: None,
        ledger: Some(ledger.clone()),
    };
    assert!(handle.send(request()).is_err());
    let db = Storage::open(&database).unwrap();
    assert_eq!(
        db.load_outbound_rpc("req_outbound_fixture")
            .unwrap()
            .unwrap()
            .status,
        OutboundStatus::NotSent
    );
    assert!(ledger.queue(&request()).unwrap());
    ledger.start(&request()).unwrap();
    let invalid = Envelope::Response {
        protocol_version: PROTOCOL_VERSION,
        request_id: RequestId("req_outbound_fixture".into()),
        kind: "browser.login.accepted".into(),
        payload: json!({"accepted": true}),
        context: empty_context(),
    };
    assert!(ledger.acknowledge(&invalid).is_err());
    assert_eq!(
        db.load_outbound_rpc("req_outbound_fixture")
            .unwrap()
            .unwrap()
            .status,
        OutboundStatus::Sending
    );
    drop(handle);
    drop(db);
    drop(ledger);
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn restart_discards_voice_without_persisting_pcm() {
    let directory = temp_dir();
    let database = directory.join("receipts.sqlite");
    let ledger = OutboundLedger::open(&database).unwrap();
    let mut voice = request();
    if let Envelope::Request {
        kind, request_id, ..
    } = &mut voice
    {
        *kind = "voice.input.append".into();
        request_id.0 = "req_voice_fixture".into();
    }
    assert!(ledger.queue(&voice).unwrap());
    ledger.start(&voice).unwrap();
    let mut pending = VecDeque::from([voice, request()]);
    discard_voice_requests(&mut pending);
    assert_eq!(pending.len(), 1);
    let db = Storage::open(&database).unwrap();
    assert!(db.load_outbound_rpc("req_voice_fixture").unwrap().is_none());
    drop(db);
    drop(ledger);
    let _ = fs::remove_dir_all(directory);
}
