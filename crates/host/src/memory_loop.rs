//! P5.16 记忆闭环验收。
//!
//! 这八个测试把已经落地的纠正、归属、范围、来源、冲突、首句时序、
//! 重启和失败任务收成一组可以重复运行的断言。它们只证明记忆增强计划
//! 的闭环，不把阶段 5、P5.8 抽查演示或 4C 标成完成。
//!
//! 断言走 Host 的公开命令和 SQLite，不另起模型，也不打开第二条写入通道。

use crate::memory_candidate::{apply_memory_candidate, MemoryCandidateStatus};
use crate::memory_context::attach_turn_memory_context;
use crate::memory_controls::{create_user_preference, list_client_memory, UserPreferenceInput};
use crate::memory_correction::{
    apply_explicit_correction, apply_turn_explicit_corrections, CorrectionOutcome,
};
use semi_os_protocol::{Envelope, EnvelopeContext, RequestId};
use semi_os_storage::{
    memory_text, MemoryActor, MemoryAuthor, MemoryBody, MemoryMutability, MemoryQuery,
    MemoryRecord, MemoryRevision, MemoryScope, MemorySourceKind, MemoryWriteCandidate,
    NewMemorySource, Storage, StorageError,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn open_file(path: &Path) -> Storage {
    Storage::open(path).expect("memory database should open")
}

fn scratch_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "semi-os-memory-loop-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

fn request(kind: &str, payload: Value) -> Envelope {
    Envelope::Request {
        protocol_version: 1,
        request_id: RequestId("req_memory_loop".into()),
        kind: kind.into(),
        payload,
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    }
}

fn event(payload: Value) -> Envelope {
    Envelope::Event {
        protocol_version: 1,
        request_id: RequestId("req_memory_loop".into()),
        kind: "memory.candidate.submit".into(),
        payload,
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    }
}

fn preference(key: &str, value: &str) -> UserPreferenceInput {
    UserPreferenceInput {
        key: key.to_owned(),
        value: value.to_owned(),
    }
}

fn turn_context(storage: &mut Storage, text: &str, workspace_id: Option<&str>) -> String {
    let mut payload = json!({
        "sessionId": "session_loop",
        "taskId": "task_loop",
        "text": text,
    });
    if let Some(workspace_id) = workspace_id {
        payload["workspaceId"] = json!(workspace_id);
        payload["cwd"] = json!(workspace_id);
    }
    let mut envelope = request("voice.text.submit", payload);
    attach_turn_memory_context(storage, &mut envelope).expect("recall should run");
    let Envelope::Request { payload, .. } = envelope else {
        panic!("turn should stay a request");
    };
    payload["memoryContext"].as_str().unwrap_or("").to_owned()
}

fn memory_ids(storage: &Storage) -> Vec<String> {
    let mut ids = storage
        .list_memories(&MemoryQuery::default())
        .expect("memories should list")
        .into_iter()
        .map(|record| record.memory_id)
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn bodies(storage: &Storage) -> String {
    storage
        .list_memories(&MemoryQuery::default())
        .expect("memories should list")
        .into_iter()
        .map(|record| memory_text(&record.body))
        .collect::<Vec<_>>()
        .join("\n")
}

fn project_fact(
    id: &str,
    fact: &str,
    workspace_id: &str,
    source_ref: &str,
) -> MemoryWriteCandidate {
    MemoryWriteCandidate {
        memory_id: id.to_owned(),
        body: MemoryBody::ProjectFact {
            fact: fact.to_owned(),
        },
        scope: MemoryScope {
            user_id: Some("local".to_owned()),
            workspace_id: Some(workspace_id.to_owned()),
            ..MemoryScope::default()
        },
        sources: vec![NewMemorySource {
            source_id: format!("src_{id}"),
            kind: MemorySourceKind::ConversationTurn,
            source_ref: source_ref.to_owned(),
            note: Some("origin=project_note".to_owned()),
        }],
        confidence: 90,
        importance: 70,
        conflict: None,
    }
}

fn workflow_candidate(memory_id: &str, summary: &str, notes: &[(&str, &str, &str)]) -> Value {
    json!({
        "memoryId": memory_id,
        "recordKind": "workflow_candidate",
        "layer": "L5",
        "content": { "kind": "workflow_candidate", "name": "browser_open", "summary": summary },
        "scope": { "userId": "local", "workspaceId": "repo_semi" },
        "confidence": 85,
        "importance": 64,
        "sourceRefs": notes.iter().enumerate().map(|(index, (kind, source_ref, note))| json!({
            "sourceId": format!("src_{memory_id}_{index}"),
            "kind": kind,
            "sourceRef": source_ref,
            "note": note
        })).collect::<Vec<_>>(),
        "conflictTarget": null,
        "origin": "verified_experience"
    })
}

#[test]
fn correction_changes_the_next_prompt() {
    let mut storage = Storage::open_in_memory().unwrap();
    create_user_preference(&mut storage, &preference("详略", "详细"), 10).unwrap();
    let before = turn_context(&mut storage, "今天怎么回复", None);
    assert!(before.contains("详细"));
    assert!(!before.contains("简短"));

    let outcome =
        apply_explicit_correction(&mut storage, "以后用简短回答", "turn_loop", 11).unwrap();
    let CorrectionOutcome::Stored { author, link, .. } = outcome else {
        panic!("explicit correction should be stored");
    };
    assert_eq!(author, MemoryAuthor::User);
    assert!(link.is_some(), "the previous preference should stay linked");

    let after = turn_context(&mut storage, "今天怎么回复", None);
    assert!(after.contains("简短"));
    assert!(!after.contains("详细"));
}

#[test]
fn agent_cannot_overwrite_user_authored_records() {
    let mut storage = Storage::open_in_memory().unwrap();
    let created = create_user_preference(&mut storage, &preference("详略", "详细"), 20).unwrap();
    let memory_id = created.preferences[0].memory_id.clone();
    let before = storage.load_memory(&memory_id).unwrap().unwrap();
    assert_eq!(before.author, MemoryAuthor::User);
    assert_eq!(before.mutability, MemoryMutability::UserReadonly);

    let revise_error = storage.revise_memory(
        MemoryActor::Agent,
        &memory_id,
        &MemoryRevision {
            body: MemoryBody::Preference {
                key: "详略".into(),
                value: "被改写".into(),
            },
            scope: before.scope.clone(),
        },
        21,
    );
    assert!(matches!(
        revise_error,
        Err(StorageError::OwnershipDenied {
            actor: "agent",
            author: "user",
            ..
        })
    ));
    let delete_error = storage.delete_memory(MemoryActor::Agent, &memory_id);
    assert!(matches!(
        delete_error,
        Err(StorageError::OwnershipDenied { .. })
    ));

    let mut hijack = workflow_candidate(
        "pref_hijack",
        "不应覆盖用户偏好",
        &[
            (
                "task_event",
                "task.completed:task_hijack",
                "completion=completed",
            ),
            (
                "receipt",
                "attempt_ok",
                "status=succeeded; verification=passed; method=fixture",
            ),
        ],
    );
    hijack["memoryId"] = json!(memory_id);
    let rejected = apply_memory_candidate(&mut storage, &event(hijack), 22);
    assert_eq!(rejected.status, MemoryCandidateStatus::Rejected);

    let after = storage.load_memory(&memory_id).unwrap().unwrap();
    assert_eq!(after, before);
}

#[test]
fn out_of_scope_memories_are_not_recalled() {
    let mut storage = Storage::open_in_memory().unwrap();
    storage
        .write_memory(
            MemoryActor::Agent,
            &project_fact(
                "fact_semi",
                "仓库收尾使用 rustfmt",
                "repo_semi",
                "turn_rustfmt",
            ),
            30,
        )
        .unwrap();
    storage
        .write_memory(
            MemoryActor::Agent,
            &project_fact("fact_other", "面包房清晨出炉", "repo_other", "turn_bakery"),
            31,
        )
        .unwrap();

    let greeting = turn_context(&mut storage, "你好", Some("repo_semi"));
    assert!(
        !greeting.contains("仓库收尾使用 rustfmt"),
        "闲聊即使带了工作区也不召回项目记忆"
    );
    assert!(!greeting.contains("面包房清晨出炉"));

    let project = turn_context(
        &mut storage,
        "继续这个项目里上次 rustfmt 的经验",
        Some("repo_semi"),
    );
    assert!(project.contains("仓库收尾使用 rustfmt"));
    assert!(
        !project.contains("面包房清晨出炉"),
        "其他仓库的记忆不能进入当前提示"
    );
}

#[test]
fn sources_stay_traceable() {
    let mut storage = Storage::open_in_memory().unwrap();
    storage
        .write_memory(
            MemoryActor::Agent,
            &project_fact(
                "fact_semi",
                "仓库收尾使用 rustfmt",
                "repo_semi",
                "turn_rustfmt",
            ),
            40,
        )
        .unwrap();
    let sources = storage.list_memory_sources("fact_semi").unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].kind, MemorySourceKind::ConversationTurn);
    assert_eq!(sources[0].source_ref, "turn_rustfmt");
    assert_ne!(
        sources[0].source_ref,
        memory_text(&MemoryBody::ProjectFact {
            fact: "仓库收尾使用 rustfmt".into(),
        })
    );

    let page = list_client_memory(&storage).unwrap();
    let item = page
        .sections
        .iter()
        .flat_map(|section| section.items.iter())
        .find(|item| item.memory_id == "fact_semi")
        .expect("the memory page should show the fact");
    assert!(item
        .sources
        .iter()
        .any(|source| source.source_ref == "turn_rustfmt"));

    let project = turn_context(
        &mut storage,
        "继续这个项目里上次 rustfmt 的经验",
        Some("repo_semi"),
    );
    assert!(
        project.contains("conversation_turn:turn_rustfmt"),
        "搜索摘要必须带可追踪的来源，而不是只剩正文"
    );
}

#[test]
fn conflicting_versions_do_not_enter_the_prompt_together() {
    let mut storage = Storage::open_in_memory().unwrap();
    create_user_preference(&mut storage, &preference("详略", "详细"), 50).unwrap();
    storage
        .write_memory(
            MemoryActor::Agent,
            &MemoryWriteCandidate {
                memory_id: "pref_agent_verbose".into(),
                body: MemoryBody::Preference {
                    key: "详略".into(),
                    value: "极简对照".into(),
                },
                scope: MemoryScope {
                    user_id: Some("local".into()),
                    ..MemoryScope::default()
                },
                sources: vec![NewMemorySource {
                    source_id: "src_pref_agent_verbose".into(),
                    kind: MemorySourceKind::ConversationTurn,
                    source_ref: "turn_agent".into(),
                    note: None,
                }],
                confidence: 90,
                importance: 70,
                conflict: None,
            },
            51,
        )
        .unwrap();
    assert!(storage.load_memory("pref_agent_verbose").unwrap().is_some());
    let mixed = turn_context(&mut storage, "今天怎么回复", None);
    assert!(mixed.contains("详细"));
    assert!(!mixed.contains("极简对照"));

    apply_explicit_correction(&mut storage, "以后用简短回答", "turn_conflict", 52).unwrap();
    let next = turn_context(&mut storage, "今天怎么回复", None);
    assert!(next.contains("简短"));
    assert!(!next.contains("详细"));
    assert!(!next.contains("极简对照"));
    assert!(storage.load_memory("pref_agent_verbose").unwrap().is_some());
}

#[test]
fn memory_writes_are_not_on_the_first_utterance_path() {
    let mut storage = Storage::open_in_memory().unwrap();
    create_user_preference(&mut storage, &preference("详略", "详细"), 60).unwrap();
    let before = memory_ids(&storage);

    let mut started = request(
        "voice.turn.start",
        json!({
            "sessionId": "session_loop",
            "taskId": "task_loop"
        }),
    );
    assert!(!apply_turn_explicit_corrections(&mut storage, &started, 61).unwrap());
    attach_turn_memory_context(&mut storage, &mut started).unwrap();
    assert_eq!(memory_ids(&storage), before, "首句开始不能新增长期记忆");

    let audio = Envelope::Event {
        protocol_version: 1,
        request_id: RequestId("req_audio".into()),
        kind: "voice.audio.chunk".into(),
        payload: json!({ "sessionId": "session_loop", "text": "以后用简短回答" }),
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    };
    assert!(!apply_turn_explicit_corrections(&mut storage, &audio, 62).unwrap());
    assert_eq!(memory_ids(&storage), before);
    assert!(bodies(&storage).contains("详细"));
    assert!(!bodies(&storage).contains("简短"));
}

#[test]
fn memory_state_survives_process_restart() {
    let dir = scratch_dir("restart");
    let path = dir.join("memory.sqlite");
    let memory_id = {
        let mut storage = open_file(&path);
        let created =
            create_user_preference(&mut storage, &preference("详略", "详细"), 70).unwrap();
        created.preferences[0].memory_id.clone()
    };
    let storage = open_file(&path);
    let record = storage
        .load_memory(&memory_id)
        .unwrap()
        .expect("a reopened database should still hold the preference");
    assert_eq!(record.author, MemoryAuthor::User);
    assert_eq!(
        record.body,
        MemoryBody::Preference {
            key: "详略".into(),
            value: "详细".into(),
        }
    );
    let page = list_client_memory(&storage).unwrap();
    assert!(page
        .preferences
        .iter()
        .any(|row| row.memory_id == memory_id && row.value == "详细"));
    drop(storage);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancelled_concurrent_and_failed_tasks_do_not_write_incorrect_memories() {
    let dir = scratch_dir("concurrent");
    let path = dir.join("memory.sqlite");
    let mut primary = open_file(&path);
    let mut secondary = open_file(&path);
    let created = create_user_preference(&mut primary, &preference("详略", "详细"), 80).unwrap();
    let memory_id = created.preferences[0].memory_id.clone();
    let before: MemoryRecord = primary.load_memory(&memory_id).unwrap().unwrap();

    let mut hijack = workflow_candidate(
        &memory_id,
        "并发任务不该改写用户偏好",
        &[
            (
                "task_event",
                "task.completed:task_hijack",
                "completion=completed",
            ),
            (
                "receipt",
                "attempt_ok",
                "status=succeeded; verification=passed; method=fixture",
            ),
        ],
    );
    hijack["memoryId"] = json!(memory_id);
    let overwrite = apply_memory_candidate(&mut secondary, &event(hijack), 81);
    assert_eq!(overwrite.status, MemoryCandidateStatus::Rejected);
    assert_eq!(primary.load_memory(&memory_id).unwrap().unwrap(), before);

    let cancelled = workflow_candidate(
        "exp_task_cancel_l5",
        "取消后不该留下的步骤",
        &[(
            "task_event",
            "task.completed:task_cancel",
            "completion=cancelled",
        )],
    );
    let failed = workflow_candidate(
        "exp_task_failed_l5",
        "失败后不该留下的步骤",
        &[(
            "receipt",
            "attempt_bad",
            "status=failed; verification=failed; method=fixture",
        )],
    );
    let verified = workflow_candidate(
        "exp_task_ok_l5",
        "已验证的资料页步骤",
        &[
            (
                "task_event",
                "task.completed:task_ok",
                "completion=completed",
            ),
            (
                "receipt",
                "attempt_ok",
                "status=succeeded; verification=passed; method=fixture",
            ),
        ],
    );
    let cancelled_result = apply_memory_candidate(&mut secondary, &event(cancelled), 82);
    let verified_result = apply_memory_candidate(&mut primary, &event(verified), 83);
    let failed_result = apply_memory_candidate(&mut secondary, &event(failed), 84);
    assert_eq!(cancelled_result.status, MemoryCandidateStatus::Rejected);
    assert_eq!(failed_result.status, MemoryCandidateStatus::Rejected);
    assert_eq!(verified_result.status, MemoryCandidateStatus::Stored);

    let stored = bodies(&primary);
    assert!(stored.contains("已验证的资料页步骤"));
    assert!(!stored.contains("取消后不该留下的步骤"));
    assert!(!stored.contains("失败后不该留下的步骤"));
    assert!(!stored.contains("并发任务不该改写用户偏好"));
    assert_eq!(primary.load_memory(&memory_id).unwrap().unwrap(), before);
    assert!(secondary
        .load_memory("exp_task_cancel_l5")
        .unwrap()
        .is_none());
    assert!(primary.load_memory("exp_task_failed_l5").unwrap().is_none());
    drop(primary);
    drop(secondary);
    let _ = std::fs::remove_dir_all(dir);
}
