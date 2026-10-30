//! P5.9 记忆验收。
//!
//! 这一组测试可以重复运行，覆盖相关召回、无关排除、纠正链接、压缩后续跑，
//! 以及 Agent 不能改用户记录。主观感觉不能代替这里的断言。
//! 它不宣称阶段 5 完成：完成还要 P5.8 的真人抽查演示。

use semi_os_storage::{
    CompactionOutcome, CompactionTurn, CompletedAction, MemoryActor, MemoryAuthor, MemoryBody,
    MemoryLayer, MemoryMutability, MemoryPackRequest, MemoryPackSlot, MemoryPackStage,
    MemoryRecallScope, MemoryRecordKind, MemoryRelation, MemoryRevision, MemoryScope,
    MemorySourceKind, MemoryWriteCandidate, NewMemory, NewMemorySource, PersonalityDraft, Storage,
    StorageError,
};

fn open() -> Storage {
    Storage::open_in_memory().expect("memory database should open")
}

fn scope() -> MemoryScope {
    MemoryScope {
        user_id: Some("user_eval".to_owned()),
        workspace_id: Some("repo_eval".to_owned()),
        application_id: None,
        task_id: None,
        skill_id: None,
    }
}

fn recall_scope() -> MemoryRecallScope {
    MemoryRecallScope {
        user_id: "user_eval".to_owned(),
        workspace_id: Some("repo_eval".to_owned()),
        application_id: None,
        task_id: None,
        skill_id: None,
    }
}

fn source(id: &str) -> NewMemorySource {
    NewMemorySource {
        source_id: format!("src_{id}"),
        kind: MemorySourceKind::ConversationTurn,
        source_ref: format!("turn_{id}"),
        note: None,
    }
}

fn preference(key: &str, value: &str) -> MemoryBody {
    MemoryBody::Preference {
        key: key.to_owned(),
        value: value.to_owned(),
    }
}

fn candidate(id: &str, body: MemoryBody, memory_scope: MemoryScope) -> MemoryWriteCandidate {
    MemoryWriteCandidate {
        memory_id: id.to_owned(),
        body,
        scope: memory_scope,
        sources: vec![source(id)],
        confidence: 90,
        importance: 70,
        conflict: None,
    }
}

fn personality() -> PersonalityDraft {
    PersonalityDraft {
        identity: "Semi 助手".to_owned(),
        tone: "平静".to_owned(),
        verbosity: "简短".to_owned(),
        language: "zh-CN".to_owned(),
        initiative: "低".to_owned(),
        behavior_boundary: "先确认外部副作用".to_owned(),
        tool_policy: "只读默认可执行".to_owned(),
        voice: "不自动播报后台任务".to_owned(),
        evolution_note: Some("不要把偏好写进这里".to_owned()),
        active: true,
    }
}

#[test]
fn memory_acceptance_covers_recall_exclusion_correction_continuity_and_ownership() {
    let mut db = open();
    db.create_personality(MemoryActor::User, "persona_eval", &personality(), 1)
        .unwrap();
    let persona_before = db
        .list_personality_versions("persona_eval")
        .expect("persona versions should load");
    assert_eq!(persona_before.len(), 1);
    assert_eq!(persona_before[0].identity, "Semi 助手");
    assert_eq!(persona_before[0].tone, "平静");

    db.write_memory(
        MemoryActor::Agent,
        &candidate(
            "mem_rustfmt",
            preference("editor", "use rustfmt before review"),
            scope(),
        ),
        10,
    )
    .unwrap();
    db.write_memory(
        MemoryActor::Agent,
        &candidate(
            "mem_bakery",
            MemoryBody::ProjectFact {
                fact: "面包房清晨出炉 sourdough".to_owned(),
            },
            scope(),
        ),
        11,
    )
    .unwrap();
    db.write_memory(
        MemoryActor::Agent,
        &candidate(
            "mem_other_repo",
            preference("editor", "use rustfmt in the other repo"),
            MemoryScope {
                user_id: Some("user_eval".to_owned()),
                workspace_id: Some("repo_other".to_owned()),
                ..MemoryScope::default()
            },
        ),
        12,
    )
    .unwrap();
    db.write_memory(
        MemoryActor::Agent,
        &candidate(
            "mem_other_user",
            preference("editor", "use rustfmt for someone else"),
            MemoryScope {
                user_id: Some("user_other".to_owned()),
                workspace_id: Some("repo_eval".to_owned()),
                ..MemoryScope::default()
            },
        ),
        13,
    )
    .unwrap();

    let hits = db
        .search_memories(&recall_scope(), "rustfmt", 8)
        .expect("recall should run");
    assert_eq!(
        hits.iter()
            .map(|hit| hit.record.memory_id.as_str())
            .collect::<Vec<_>>(),
        vec!["mem_rustfmt"],
        "相关记忆应被召回，同范围无关记忆和其他仓库、其他用户的记录应被排除"
    );
    assert_eq!(hits[0].record.layer, MemoryLayer::L2);
    assert!(!hits[0].sources.is_empty(), "召回结果必须带来源");
    assert!(hits[0]
        .sources
        .iter()
        .all(|item| !item.source_ref.is_empty()));
    for excluded in ["mem_bakery", "mem_other_repo", "mem_other_user"] {
        assert!(db.load_memory(excluded).unwrap().is_some());
    }

    db.create_memory(
        MemoryActor::User,
        &NewMemory {
            memory_id: "pref_font".into(),
            body: preference("font", "serif"),
            scope: scope(),
            sources: vec![NewMemorySource {
                source_id: "src_pref_font".into(),
                kind: MemorySourceKind::UserEntry,
                source_ref: "client-preference".into(),
                note: None,
            }],
        },
        20,
    )
    .unwrap();
    let user_before = db.load_memory("pref_font").unwrap().unwrap();
    assert_eq!(user_before.author, MemoryAuthor::User);
    assert_eq!(user_before.mutability, MemoryMutability::UserReadonly);

    let correction = db
        .write_memory(
            MemoryActor::Agent,
            &candidate("pref_font_agent", preference("font", "sans"), scope()),
            21,
        )
        .unwrap();
    let semi_os_storage::MemoryWriteOutcome::Stored { record, link } = correction else {
        panic!("correction should add a new agent row");
    };
    assert_eq!(record.memory_id, "pref_font_agent");
    assert_eq!(record.author, MemoryAuthor::Agent);
    assert_eq!(record.mutability, MemoryMutability::AgentMutable);
    let link = link.expect("correction should link to the user row");
    assert_eq!(link.relation, MemoryRelation::Contradicts);
    assert_eq!(link.from_memory_id, "pref_font_agent");
    assert_eq!(link.to_memory_id, "pref_font");
    assert_eq!(db.load_memory("pref_font").unwrap().unwrap(), user_before);

    let revise_error = db.revise_memory(
        MemoryActor::Agent,
        "pref_font",
        &MemoryRevision {
            body: preference("font", "mono"),
            scope: scope(),
        },
        22,
    );
    assert!(matches!(
        revise_error,
        Err(StorageError::OwnershipDenied {
            actor: "agent",
            record_class: "偏好",
            author: "user",
        })
    ));
    let delete_error = db.delete_memory(MemoryActor::Agent, "pref_font");
    assert!(matches!(
        delete_error,
        Err(StorageError::OwnershipDenied {
            actor: "agent",
            author: "user",
            ..
        })
    ));
    assert_eq!(db.load_memory("pref_font").unwrap().unwrap(), user_before);

    let outcome = db
        .compact_session(
            MemoryActor::Agent,
            &semi_os_storage::SessionCompactionRequest {
                memory_id: "compact_eval".into(),
                scope: scope(),
                sources: vec![NewMemorySource {
                    source_id: "src_compact_eval".into(),
                    kind: MemorySourceKind::PiSession,
                    source_ref: "pi_eval".into(),
                    note: None,
                }],
                threshold_tokens: 1,
                objective: "整理验收记录".into(),
                constraints: "不要改用户偏好，也不要改人格".into(),
                decisions: "先保留 unknown，再继续当前任务".into(),
                completed_actions: vec![CompletedAction {
                    summary: "已完成相关记忆召回".into(),
                    receipt_id: "receipt_eval_1".into(),
                }],
                pending: "核对压缩后的上下文".into(),
                next_step: "读取 L0 摘要再继续".into(),
                unknown_outcomes: "desktop_click 结果仍是 unknown".into(),
                workspace: "repo_eval".into(),
                application: "Semi-OS".into(),
                target: "memory-acceptance".into(),
                latest_instruction: "打断后继续验收".into(),
                turns: vec![
                    CompactionTurn {
                        turn_ref: "turn_eval_old".into(),
                        text: "更早的回合只留在会话里，不晋升成长期记忆。".into(),
                    },
                    CompactionTurn {
                        turn_ref: "turn_eval_recent".into(),
                        text: "最近仍在核对记忆范围".into(),
                    },
                ],
                retain_recent_turns: 1,
                conflict: None,
            },
            30,
        )
        .unwrap();
    let CompactionOutcome::Ready(ready) = outcome else {
        panic!("session over the threshold should compact, got {outcome:?}");
    };
    assert!(!ready.reused_existing);
    assert_eq!(ready.summary.layer, MemoryLayer::L0);
    assert_eq!(
        ready.summary.record_kind,
        MemoryRecordKind::CompactionSummary
    );
    assert_eq!(ready.latest_instruction, "打断后继续验收");
    assert_eq!(ready.recent_turns.len(), 1);
    assert_eq!(ready.recent_turns[0].turn_ref, "turn_eval_recent");
    let MemoryBody::CompactionSummary {
        objective,
        completed_actions,
        unknown_outcomes,
        latest_instruction,
        active_context,
        ..
    } = &ready.summary.body
    else {
        panic!("compaction summary should stay a summary body");
    };
    assert_eq!(objective, "整理验收记录");
    assert!(completed_actions.contains("receipt_eval_1"));
    assert!(unknown_outcomes.contains("unknown"));
    assert_eq!(latest_instruction, "打断后继续验收");
    assert!(active_context.contains("repo_eval"));
    assert!(active_context.contains("Semi-OS"));
    assert!(active_context.contains("memory-acceptance"));

    let pack = db
        .load_memory_pack(&MemoryPackRequest {
            scope: recall_scope(),
            stage: MemoryPackStage::Base,
            token_budget: 4_000,
            host_policy: "外部副作用需要确认".into(),
            query: String::new(),
            selected_memory_id: None,
        })
        .unwrap();
    assert!(!pack.truncated);
    assert_eq!(pack.entries[0].slot, MemoryPackSlot::HostPolicy);
    assert_eq!(pack.entries[1].slot, MemoryPackSlot::CompactPersona);
    let mut previous = 0;
    for entry in &pack.entries {
        assert!(entry.slot.order() >= previous, "pack order must stay fixed");
        previous = entry.slot.order();
    }
    let l0 = pack
        .entries
        .iter()
        .find(|entry| entry.memory_id.as_deref() == Some("compact_eval"))
        .expect("compaction summary should remain available as L0");
    assert_eq!(l0.slot, MemoryPackSlot::L0);
    assert!(l0.text.contains("整理验收记录"));
    assert!(l0.text.contains("receipt_eval_1"));
    assert!(l0.text.contains("unknown"));
    assert!(l0.text.contains("打断后继续验收"));
    let persona = db.load_compact_persona().unwrap().unwrap();
    assert_eq!(persona.personality_id, "persona_eval");
    assert_eq!(persona.version, 1);
    assert_eq!(persona.identity, "Semi 助手");
    assert_eq!(persona.tone, "平静");
    assert!(!persona.text.contains("rustfmt"));
    assert!(!persona.text.contains("serif"));
    assert!(!persona.text.contains("sans"));
    assert!(!persona.text.contains("不要把偏好写进这里"));
    assert_eq!(
        db.list_personality_versions("persona_eval").unwrap(),
        persona_before
    );
    assert_eq!(db.load_memory("pref_font").unwrap().unwrap(), user_before);
    let recalled = db.search_memories(&recall_scope(), "rustfmt", 8).unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].record.memory_id, "mem_rustfmt");
}
