use semi_os_protocol::{ResultType, TaskLifecycle, ToolRiskLevel};
use semi_os_storage::{
    AgentSessionCheckpoint, DesktopActionRecord, NewTaskEvent, Storage, StorageError, TaskSnapshot,
    ToolAttempt, ToolAttemptStatus, ToolReplayDecision,
};
use serde_json::json;
use tempfile::tempdir;

fn initial_task() -> TaskSnapshot {
    TaskSnapshot {
        task_id: "task_research".to_owned(),
        task_run_id: "run_001".to_owned(),
        trace_id: "trace_001".to_owned(),
        lifecycle: TaskLifecycle::Created,
        title: Some("调研 Agent 记忆系统".to_owned()),
        current_step: None,
        checkpoint: None,
        last_event_sequence: 0,
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
    }
}

#[test]
fn migrates_all_core_tables_on_reopen() {
    let directory = tempdir().expect("temporary directory should be available");
    let database_path = directory.path().join("semi-os.sqlite3");

    let storage = Storage::open(&database_path).expect("database should migrate");
    assert_eq!(storage.schema_version().expect("version should load"), 14);
    drop(storage);

    let connection = rusqlite::Connection::open(&database_path).expect("database should open");
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .expect("schema query should prepare");
    let table_names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("schema query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("table names should decode");
    assert_eq!(
        table_names,
        vec![
            "agent_runs",
            "agent_sessions",
            "approvals",
            "artifacts",
            "capabilities",
            "client_sessions",
            "conversation_turns",
            "desktop_actions",
            "memories",
            "memory_links",
            "memory_sources",
            "outbound_rpc_receipts",
            "personality_records",
            "research_reports",
            "research_sources",
            "rpc_receipts",
            "schema_migrations",
            "settings",
            "task_events",
            "tasks",
            "tool_attempts",
            "workflow_applications",
            "workflow_coordinators",
            "workflow_decision_requests",
            "workflow_decisions",
            "workflow_delegate_decisions",
            "workflow_events",
            "workflow_evidence",
            "workflow_evidence_history",
            "workflow_grants",
            "workflow_plans",
            "workflow_run_phases",
            "workflows",
        ]
    );
    drop(statement);
    drop(connection);

    let reopened = Storage::open(&database_path).expect("migration should be idempotent");
    assert_eq!(reopened.schema_version().expect("version should load"), 14);
}

#[test]
fn sessions_persist_empty_entries_selection_and_separate_turns() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("sessions.sqlite3");
    let mut storage = Storage::open(&path).unwrap();
    storage
        .save_conversation("req_old", &json!({"transcript":"历史"}), 1)
        .unwrap();
    storage
        .create_client_session("session_new", "工作", 2)
        .unwrap();
    storage.activate_client_session("session_new").unwrap();
    assert!(matches!(
        storage.activate_client_session("missing"),
        Err(StorageError::SessionNotFound(_))
    ));
    drop(storage);
    let mut reopened = Storage::open(&path).unwrap();
    let sessions = reopened.load_client_sessions().unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(sessions
        .iter()
        .any(|session| session.session_id == "session_new" && session.active));
    reopened
        .save_conversation(
            "req_new",
            &json!({"sessionId":"session_new","transcript":"新的话题"}),
            3,
        )
        .unwrap();
    let turns = reopened.load_conversations().unwrap();
    assert_eq!(turns[0]["sessionId"], "session_new");
    assert_eq!(turns[1]["sessionId"], "session_default");
    assert_eq!(
        reopened
            .load_client_sessions()
            .unwrap()
            .iter()
            .find(|session| session.session_id == "session_new")
            .unwrap()
            .title,
        "工作"
    );
    reopened.activate_client_session("session_default").unwrap();
    reopened
        .rename_client_session("session_new", "已重命名")
        .unwrap();
    assert_eq!(
        reopened
            .load_client_sessions()
            .unwrap()
            .iter()
            .filter(|session| session.active)
            .count(),
        1
    );
    drop(reopened);
    assert!(Storage::open(&path)
        .unwrap()
        .load_client_sessions()
        .unwrap()
        .iter()
        .any(|session| session.session_id == "session_new" && session.title == "已重命名"));
}

#[test]
fn session_names_validate_and_survive_rename_and_new_messages() {
    let mut storage = Storage::open_in_memory().unwrap();
    for invalid in [
        " ".to_owned(),
        "a".repeat(81),
        "😀".repeat(41),
        "a\nb".into(),
    ] {
        assert!(storage
            .create_client_session("invalid", &invalid, 1)
            .is_err());
        assert!(storage
            .rename_client_session("session_default", &invalid)
            .is_err());
    }
    storage
        .rename_client_session("session_default", "  项目讨论  ")
        .unwrap();
    storage
        .save_conversation("req_named", &json!({"transcript":"不要覆盖名称"}), 1)
        .unwrap();
    assert_eq!(storage.load_client_sessions().unwrap()[0].title, "项目讨论");
    assert!(matches!(
        storage.rename_client_session("missing", "名字"),
        Err(StorageError::SessionNotFound(_))
    ));
}

#[test]
fn session_deletion_is_atomic_and_only_removes_its_chat_archive() {
    let mut storage = Storage::open_in_memory().unwrap();
    storage
        .save_conversation("req_default", &json!({"transcript":"保留"}), 1)
        .unwrap();
    storage.create_client_session("a", "会话 A", 2).unwrap();
    storage
        .save_conversation("req_a", &json!({"sessionId":"a","transcript":"删除"}), 3)
        .unwrap();
    assert!(storage.delete_client_session("session_default").is_err());
    assert!(storage
        .activate_and_delete_client_session("a", Some("missing"))
        .is_err());
    assert!(storage
        .load_client_sessions()
        .unwrap()
        .iter()
        .any(|s| s.session_id == "session_default" && s.active));
    storage.delete_client_session("a").unwrap();
    assert_eq!(storage.load_conversations().unwrap().len(), 1);
    storage
        .create_client_session("replacement", "新会话", 4)
        .unwrap();
    storage
        .activate_and_delete_client_session("replacement", Some("session_default"))
        .unwrap();
    let sessions = storage.load_client_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].active);
    assert!(storage.load_conversations().unwrap().is_empty());
    assert!(storage
        .activate_and_delete_client_session("replacement", Some("replacement"))
        .is_err());
}

#[test]
fn legacy_runtime_ids_are_archived_under_default_without_rewriting_raw_json() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_core.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0002_research.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0003_conversations.sql"))
        .unwrap();
    connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at_ms INTEGER);
        INSERT INTO schema_migrations VALUES(1,'core',0),(2,'research',0),(3,'conversations',0);
        INSERT INTO conversation_turns VALUES('req_old','{\"sessionId\":\"session_original\"}',1);").unwrap();
    drop(connection);
    let storage = Storage::open(&path).unwrap();
    assert_eq!(
        storage.load_conversations().unwrap()[0]["sessionId"],
        "session_default"
    );
    let connection = rusqlite::Connection::open(&path).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT conversation_json FROM conversation_turns",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(raw.contains("session_original"));
}
#[test]
fn restores_final_conversations_and_upserts_a_turn() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("conversation.sqlite3");
    let mut storage = Storage::open(&database_path).unwrap();
    storage
        .save_conversation(
            "req_one",
            &json!({"requestId":"req_one","summary":"初稿"}),
            1,
        )
        .unwrap();
    storage
        .save_conversation(
            "req_one",
            &json!({"requestId":"req_one","summary":"最终回答","report":"## 来源"}),
            2,
        )
        .unwrap();
    storage
        .save_conversation(
            "req_two",
            &json!({"requestId":"req_two","error":"播放失败"}),
            3,
        )
        .unwrap();
    drop(storage);
    let restored = Storage::open(&database_path)
        .unwrap()
        .load_conversations()
        .unwrap();
    assert_eq!(restored.len(), 2);
    assert_eq!(restored[0]["requestId"], "req_two");
    assert_eq!(restored[1]["summary"], "最终回答");
    assert_eq!(restored[1]["report"], "## 来源");
}

#[test]
fn desktop_action_recovery_preserves_unknown_side_effects() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("desktop-actions.sqlite3");
    let mut storage = Storage::open(&path).unwrap();
    let record = DesktopActionRecord {
        request_id: "desktop_req_1".into(),
        task_id: "task_desktop".into(),
        attempt_id: "attempt_1".into(),
        action_kind: "desktop_type".into(),
        lease_generation: 7,
        stage: "not_dispatched".into(),
        summary: "参数已核对".into(),
    };
    storage
        .claim_desktop_action(&record, None, "sha256:input", 10)
        .unwrap();
    storage
        .update_desktop_action(
            &record.request_id,
            "possibly_dispatched",
            7,
            "已进入系统调用",
            11,
        )
        .unwrap();
    drop(storage);

    let mut reopened = Storage::open(&path).unwrap();
    reopened.recover_desktop_actions(20).unwrap();
    let actions = reopened.load_desktop_actions().unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].stage, "unknown");
    assert!(actions[0].summary.contains("可能已经执行"));
    assert!(matches!(
        reopened.update_desktop_action(
            &record.request_id,
            "possibly_dispatched",
            7,
            "不应回退",
            21,
        ),
        Err(StorageError::InvalidDesktopTransition)
    ));
}

#[test]
fn desktop_action_request_and_attempt_ids_are_not_reusable() {
    let mut storage = Storage::open_in_memory().unwrap();
    let record = DesktopActionRecord {
        request_id: "desktop_req_duplicate".into(),
        task_id: "task_desktop".into(),
        attempt_id: "attempt_duplicate".into(),
        action_kind: "desktop_click".into(),
        lease_generation: 1,
        stage: "not_dispatched".into(),
        summary: "参数已核对".into(),
    };
    storage
        .claim_desktop_action(&record, None, "sha256:one", 10)
        .unwrap();
    assert!(storage
        .claim_desktop_action(&record, None, "sha256:two", 11)
        .is_err());
}

#[test]
fn atomically_updates_snapshot_and_appends_ordered_events() {
    let mut storage = Storage::open_in_memory().expect("storage should open");
    let first = storage
        .persist_task_event(
            initial_task(),
            NewTaskEvent {
                event_id: "evt_created".to_owned(),
                event_kind: "task.created".to_owned(),
                payload: json!({ "source": "voice" }),
                occurred_at_ms: 1_000,
            },
        )
        .expect("first event should persist");
    assert_eq!(first.sequence, 1);

    let mut running = first.projection.clone();
    running.lifecycle = TaskLifecycle::Running;
    running.current_step = Some("收集资料".to_owned());
    running.checkpoint = Some(json!({ "planCursor": 2 }));
    running.updated_at_ms = 2_000;
    let second = storage
        .persist_task_event(
            running.clone(),
            NewTaskEvent {
                event_id: "evt_running".to_owned(),
                event_kind: "task.running".to_owned(),
                payload: json!({ "step": "collect" }),
                occurred_at_ms: 2_000,
            },
        )
        .expect("second event should persist");

    let snapshot = storage
        .load_task("task_research")
        .expect("snapshot query should succeed")
        .expect("snapshot should exist");
    assert_eq!(snapshot, second.projection);
    assert_eq!(snapshot.last_event_sequence, 2);
    assert_eq!(
        storage
            .load_task_events("task_research")
            .expect("events should load")
            .len(),
        2
    );

    let stale_result = storage.persist_task_event(
        running,
        NewTaskEvent {
            event_id: "evt_stale".to_owned(),
            event_kind: "task.paused".to_owned(),
            payload: json!({}),
            occurred_at_ms: 3_000,
        },
    );
    assert!(matches!(
        stale_result,
        Err(StorageError::EventSequenceConflict {
            expected: 1,
            actual: 2,
            ..
        })
    ));
    assert_eq!(
        storage
            .load_task_events("task_research")
            .expect("events should load")
            .len(),
        2,
        "冲突事务不能留下孤立事件"
    );

    let mut duplicate_event_projection = second.projection.clone();
    duplicate_event_projection.lifecycle = TaskLifecycle::Paused;
    duplicate_event_projection.updated_at_ms = 3_000;
    let duplicate_event_result = storage.persist_task_event(
        duplicate_event_projection,
        NewTaskEvent {
            event_id: "evt_running".to_owned(),
            event_kind: "task.paused".to_owned(),
            payload: json!({ "reason": "user_interruption" }),
            occurred_at_ms: 3_000,
        },
    );
    assert!(
        duplicate_event_result.is_err(),
        "重复事件 ID 应触发唯一约束"
    );
    assert_eq!(
        storage
            .load_task("task_research")
            .expect("snapshot query should succeed")
            .expect("snapshot should exist"),
        second.projection,
        "事件追加失败时，快照更新必须随事务一起回滚"
    );
}

#[test]
fn replays_projection_restores_checkpoint_and_reuses_completed_receipt() {
    let directory = tempdir().expect("temporary directory should be available");
    let database_path = directory.path().join("recovery.sqlite3");

    {
        let mut storage = Storage::open(&database_path).expect("storage should open");
        let created = storage
            .persist_task_event(
                initial_task(),
                NewTaskEvent {
                    event_id: "evt_created".to_owned(),
                    event_kind: "task.created".to_owned(),
                    payload: json!({}),
                    occurred_at_ms: 1_000,
                },
            )
            .expect("created event should persist");

        let mut running = created.projection;
        running.lifecycle = TaskLifecycle::Running;
        running.current_step = Some("打开资料页".to_owned());
        running.checkpoint = Some(json!({
            "piSession": "pi_session_01",
            "turn": 4,
            "pendingStep": "summarize"
        }));
        running.updated_at_ms = 2_000;
        storage
            .persist_task_event(
                running,
                NewTaskEvent {
                    event_id: "evt_tool_done".to_owned(),
                    event_kind: "tool.succeeded".to_owned(),
                    payload: json!({ "attemptId": "attempt_01" }),
                    occurred_at_ms: 2_000,
                },
            )
            .expect("tool event should persist");

        storage
            .save_agent_checkpoint(&AgentSessionCheckpoint {
                session_id: "session_01".to_owned(),
                task_id: Some("task_research".to_owned()),
                runtime_kind: "pi".to_owned(),
                runtime_session_ref: Some("pi_session_01".to_owned()),
                checkpoint: Some(json!({ "turn": 4, "summary": "已收集两个来源" })),
                checkpoint_sequence: 2,
                created_at_ms: 1_000,
                updated_at_ms: 2_000,
            })
            .expect("checkpoint should persist");

        storage
            .save_tool_attempt(&ToolAttempt {
                attempt_id: "attempt_01".to_owned(),
                task_id: "task_research".to_owned(),
                tool_name: "browser_open".to_owned(),
                idempotency_key: "open:docs.example.test".to_owned(),
                attempt_number: 1,
                status: ToolAttemptStatus::Succeeded,
                risk_level: ToolRiskLevel::Read,
                input_digest: "sha256:input".to_owned(),
                target: Some(json!({ "url": "https://docs.example.test" })),
                policy: Some(json!({ "decision": "auto" })),
                result_type: Some(ResultType::Success),
                receipt: Some(json!({ "pageId": "page_01", "status": 200 })),
                verification: Some(json!({ "observed": true })),
                started_at_ms: 1_500,
                finished_at_ms: Some(1_900),
            })
            .expect("receipt should persist");
    }

    // 模拟 Host/Worker 全部退出后重新打开数据库，恢复不能依赖进程内对象。
    let storage = Storage::open(&database_path).expect("storage should reopen");
    let replayed = storage
        .replay_task("task_research")
        .expect("task should replay");
    assert_eq!(replayed.lifecycle, TaskLifecycle::Running);
    assert_eq!(replayed.last_event_sequence, 2);
    assert_eq!(
        replayed.checkpoint,
        Some(json!({
            "piSession": "pi_session_01",
            "turn": 4,
            "pendingStep": "summarize"
        }))
    );

    let checkpoint = storage
        .load_agent_checkpoint("session_01")
        .expect("checkpoint query should succeed")
        .expect("checkpoint should exist");
    assert_eq!(checkpoint.checkpoint_sequence, 2);
    assert_eq!(
        checkpoint.checkpoint,
        Some(json!({ "turn": 4, "summary": "已收集两个来源" }))
    );

    match storage
        .tool_replay_decision("task_research", "open:docs.example.test")
        .expect("decision should load")
    {
        ToolReplayDecision::ReuseCompleted(attempt) => {
            assert_eq!(attempt.attempt_id, "attempt_01");
            assert_eq!(
                attempt.receipt,
                Some(json!({ "pageId": "page_01", "status": 200 }))
            );
        }
        decision => panic!("completed receipt must be reused, got {decision:?}"),
    }
}

#[test]
fn incomplete_attempt_requires_reconciliation_before_retry() {
    let mut storage = Storage::open_in_memory().expect("storage should open");
    let created = storage
        .persist_task_event(
            initial_task(),
            NewTaskEvent {
                event_id: "evt_created".to_owned(),
                event_kind: "task.created".to_owned(),
                payload: json!({}),
                occurred_at_ms: 1_000,
            },
        )
        .expect("task should persist");
    assert_eq!(created.sequence, 1);

    storage
        .save_tool_attempt(&ToolAttempt {
            attempt_id: "attempt_unknown".to_owned(),
            task_id: "task_research".to_owned(),
            tool_name: "lark_send_message".to_owned(),
            idempotency_key: "message:chat_01:digest_01".to_owned(),
            attempt_number: 1,
            status: ToolAttemptStatus::Unknown,
            risk_level: ToolRiskLevel::ExternalSideEffect,
            input_digest: "digest_01".to_owned(),
            target: Some(json!({ "chatId": "chat_01" })),
            policy: Some(json!({ "approvalId": "approval_01" })),
            result_type: Some(ResultType::Unknown),
            receipt: None,
            verification: Some(json!({ "reason": "network_lost_after_send" })),
            started_at_ms: 1_500,
            finished_at_ms: Some(1_800),
        })
        .expect("unknown attempt should persist");

    assert!(matches!(
        storage
            .tool_replay_decision("task_research", "message:chat_01:digest_01")
            .expect("decision should load"),
        ToolReplayDecision::ReconcileIncomplete(_)
    ));
    assert_eq!(
        storage
            .tool_replay_decision("task_research", "new-operation")
            .expect("decision should load"),
        ToolReplayDecision::Execute
    );
}

#[test]
fn terminal_unsuccessful_attempt_does_not_block_a_new_attempt() {
    let mut storage = Storage::open_in_memory().expect("storage should open");
    storage
        .persist_task_event(
            initial_task(),
            NewTaskEvent {
                event_id: "evt_created".to_owned(),
                event_kind: "task.created".to_owned(),
                payload: json!({}),
                occurred_at_ms: 1_000,
            },
        )
        .expect("task should persist");
    storage
        .save_tool_attempt(&ToolAttempt {
            attempt_id: "attempt_failed".to_owned(),
            task_id: "task_research".to_owned(),
            tool_name: "browser_open".to_owned(),
            idempotency_key: "open:unavailable.example.test".to_owned(),
            attempt_number: 1,
            status: ToolAttemptStatus::Failed,
            risk_level: ToolRiskLevel::Read,
            input_digest: "digest_failed".to_owned(),
            target: Some(json!({ "url": "https://unavailable.example.test" })),
            policy: Some(json!({ "decision": "auto" })),
            result_type: Some(ResultType::Failure),
            receipt: None,
            verification: Some(json!({ "networkRequestStarted": false })),
            started_at_ms: 1_500,
            finished_at_ms: Some(1_600),
        })
        .expect("failed attempt should persist");

    assert_eq!(
        storage
            .tool_replay_decision("task_research", "open:unavailable.example.test")
            .expect("decision should load"),
        ToolReplayDecision::Execute
    );
}
