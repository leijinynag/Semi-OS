//! 客户端记忆页的 Host 命令。
//!
//! WebView 不能打开 SQLite，也不能自己指定调用者。这里固定以用户身份写入，
//! 而且只接受偏好正文。Agent 记忆和系统记录出现在同一页快照里，带来源归属，
//! 但没有修改入口。人格表只读出版本指纹：偏好写入不调用人格接口，避免用户
//! 偏好被静默写成人格定义。
//!
//! 这一页是本机库的归属视图，不是 Agent 的范围检索。跨用户、跨仓库的过滤仍由
//! `search_memories` 执行。损坏记录必须让整页失败，不能跳过一条后假装没有。

use semi_os_storage::{
    MemoryActor, MemoryAuthor, MemoryBody, MemoryLayer, MemoryMutability, MemoryQuery,
    MemoryRecord, MemoryRecordKind, MemoryRevision, MemoryScope, MemorySourceKind, NewMemory,
    NewMemorySource, Storage, StorageError, StorageResult,
};
use serde::{Deserialize, Serialize};

/// 本机客户端写入偏好时使用的用户范围。界面不能改这个身份。
pub const CLIENT_USER_ID: &str = "local";

const DUPLICATE_PREFERENCE: &str = "同一范围已有这个偏好，请直接编辑";
const OWN_PREFERENCE_ONLY: &str = "只能修改自己的偏好";
const SUMMARY_CHARS: usize = 160;

/// 用户在记忆页提交的偏好。键和值的合法性由存储层最终判定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPreferenceInput {
    pub key: String,
    pub value: String,
}

/// 一条用户偏好。只有这一节可以创建、编辑和删除。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPreferenceRow {
    pub memory_id: String,
    pub key: String,
    pub value: String,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
    pub updated_at_ms: i64,
}

/// 只读记忆行。归属同时给出作者和可变更性，界面不能据此推断任务成败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryRow {
    pub memory_id: String,
    pub layer: MemoryLayer,
    pub record_kind: MemoryRecordKind,
    pub summary: String,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
    pub updated_at_ms: i64,
}

/// 当前生效人格的指纹。不含语气正文，避免和偏好值混在同一个可编辑字段里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPersonaFingerprint {
    pub personality_id: String,
    pub version: i64,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
}

/// 记忆页快照。写操作返回整页，界面用它替换本地状态，而不是自行打补丁。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryPage {
    pub preferences: Vec<ClientPreferenceRow>,
    pub memories: Vec<ClientMemoryRow>,
    pub persona: Option<ClientPersonaFingerprint>,
}

/// 给界面的稳定文案。不回显存储错误里的原文，避免把秘密或路径带进 WebView。
pub fn client_memory_message(error: &StorageError) -> &'static str {
    match error {
        StorageError::OwnershipDenied { .. } => "这条记录不能由当前操作修改",
        StorageError::MemoryNotFound(_) => "找不到这条记录",
        StorageError::InvalidMemory(message) => match message.as_str() {
            DUPLICATE_PREFERENCE => DUPLICATE_PREFERENCE,
            OWN_PREFERENCE_ONLY => OWN_PREFERENCE_ONLY,
            _ => "偏好内容无效",
        },
        _ => "本地存储暂不可用",
    }
}

pub fn list_client_memory(storage: &Storage) -> StorageResult<ClientMemoryPage> {
    page(storage)
}

pub fn create_user_preference(
    storage: &mut Storage,
    input: &UserPreferenceInput,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    let scope = local_scope();
    if key_taken(storage, &scope.user_id, &input.key, None)? {
        return Err(StorageError::InvalidMemory(DUPLICATE_PREFERENCE.to_owned()));
    }
    let memory_id = allocate_preference_id(storage, now)?;
    let source_id = format!("src_{memory_id}");
    storage.create_memory(
        MemoryActor::User,
        &NewMemory {
            memory_id,
            body: preference_body(input),
            scope,
            sources: vec![NewMemorySource {
                source_id,
                kind: MemorySourceKind::UserEntry,
                source_ref: "client-preference".to_owned(),
                note: None,
            }],
        },
        now,
    )?;
    page(storage)
}

pub fn revise_user_preference(
    storage: &mut Storage,
    memory_id: &str,
    input: &UserPreferenceInput,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    let existing = require_user_preference(storage, memory_id)?;
    if key_taken(
        storage,
        &existing.scope.user_id,
        &input.key,
        Some(memory_id),
    )? {
        return Err(StorageError::InvalidMemory(DUPLICATE_PREFERENCE.to_owned()));
    }
    storage.revise_memory(
        MemoryActor::User,
        memory_id,
        &MemoryRevision {
            body: preference_body(input),
            scope: existing.scope,
        },
        now,
    )?;
    page(storage)
}

pub fn delete_user_preference(
    storage: &mut Storage,
    memory_id: &str,
) -> StorageResult<ClientMemoryPage> {
    require_user_preference(storage, memory_id)?;
    storage.delete_memory(MemoryActor::User, memory_id)?;
    page(storage)
}

fn page(storage: &Storage) -> StorageResult<ClientMemoryPage> {
    let records = storage.list_memories(&MemoryQuery::default())?;
    let mut preferences = Vec::new();
    let mut memories = Vec::new();
    for record in records {
        if record.author == MemoryAuthor::User && record.record_kind == MemoryRecordKind::Preference
        {
            preferences.push(preference_row(&record)?);
        } else {
            memories.push(memory_row(&record));
        }
    }
    preferences.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
    memories.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
    let persona = storage
        .load_compact_persona()?
        .map(|persona| ClientPersonaFingerprint {
            personality_id: persona.personality_id,
            version: persona.version,
            author: persona.author,
            mutability: persona.mutability,
        });
    Ok(ClientMemoryPage {
        preferences,
        memories,
        persona,
    })
}

fn require_user_preference(storage: &Storage, memory_id: &str) -> StorageResult<MemoryRecord> {
    let record = storage
        .load_memory(memory_id)?
        .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
    if record.author != MemoryAuthor::User {
        return Err(StorageError::OwnershipDenied {
            actor: "user",
            record_class: "偏好",
            author: record.author.as_str(),
        });
    }
    if record.record_kind != MemoryRecordKind::Preference
        || record.mutability != MemoryMutability::UserReadonly
    {
        return Err(StorageError::InvalidMemory(OWN_PREFERENCE_ONLY.to_owned()));
    }
    Ok(record)
}

fn preference_row(record: &MemoryRecord) -> StorageResult<ClientPreferenceRow> {
    let MemoryBody::Preference { key, value } = &record.body else {
        return Err(StorageError::InvalidMemory(
            "偏好正文与种类不一致".to_owned(),
        ));
    };
    Ok(ClientPreferenceRow {
        memory_id: record.memory_id.clone(),
        key: key.clone(),
        value: value.clone(),
        author: record.author,
        mutability: record.mutability,
        updated_at_ms: record.updated_at_ms,
    })
}

fn memory_row(record: &MemoryRecord) -> ClientMemoryRow {
    ClientMemoryRow {
        memory_id: record.memory_id.clone(),
        layer: record.layer,
        record_kind: record.record_kind,
        summary: summarize(&record.body),
        author: record.author,
        mutability: record.mutability,
        updated_at_ms: record.updated_at_ms,
    }
}

fn preference_body(input: &UserPreferenceInput) -> MemoryBody {
    MemoryBody::Preference {
        key: input.key.clone(),
        value: input.value.clone(),
    }
}

fn local_scope() -> MemoryScope {
    MemoryScope {
        user_id: Some(CLIENT_USER_ID.to_owned()),
        ..MemoryScope::default()
    }
}

fn key_taken(
    storage: &Storage,
    user_id: &Option<String>,
    key: &str,
    except: Option<&str>,
) -> StorageResult<bool> {
    let needle = key.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(false);
    }
    let records = storage.list_memories(&MemoryQuery {
        record_kind: Some(MemoryRecordKind::Preference),
        author: Some(MemoryAuthor::User),
        ..MemoryQuery::default()
    })?;
    Ok(records.into_iter().any(|record| {
        except != Some(record.memory_id.as_str())
            && &record.scope.user_id == user_id
            && preference_key(&record.body).as_deref() == Some(needle.as_str())
    }))
}

fn preference_key(body: &MemoryBody) -> Option<String> {
    match body {
        MemoryBody::Preference { key, .. } => Some(key.trim().to_lowercase()),
        _ => None,
    }
}

fn allocate_preference_id(storage: &Storage, now: i64) -> StorageResult<String> {
    if now < 0 {
        return Err(StorageError::InvalidMemory("时间不能为负".to_owned()));
    }
    for seq in 0..32 {
        let memory_id = if seq == 0 {
            format!("pref_{now}")
        } else {
            format!("pref_{now}_{seq}")
        };
        if storage.load_memory(&memory_id)?.is_none() {
            return Ok(memory_id);
        }
    }
    Err(StorageError::InvalidMemory("偏好编号暂时不可用".to_owned()))
}

fn summarize(body: &MemoryBody) -> String {
    let text = match body {
        MemoryBody::PiSession {
            runtime_session_ref,
            note,
        } => join([Some(runtime_session_ref.as_str()), note.as_deref()]),
        MemoryBody::RecentTurn { turn_ref, excerpt } => {
            join([Some(turn_ref.as_str()), Some(excerpt.as_str())])
        }
        MemoryBody::CurrentPlan {
            objective,
            next_step,
        } => join([Some(objective.as_str()), Some(next_step.as_str())]),
        MemoryBody::CompactionSummary {
            objective,
            latest_instruction,
            unknown_outcomes,
            ..
        } => join([
            Some(objective.as_str()),
            Some(unknown_outcomes.as_str()),
            Some(latest_instruction.as_str()),
        ]),
        MemoryBody::SafetyRule { statement }
        | MemoryBody::ToolBoundary { statement }
        | MemoryBody::ConfirmationPolicy { statement } => statement.clone(),
        MemoryBody::Profile { fact } | MemoryBody::ProjectFact { fact } => fact.clone(),
        MemoryBody::Preference { key, value } => format!("{key}：{value}"),
        MemoryBody::ApplicationHabit { application, habit } => format!("{application}：{habit}"),
        MemoryBody::TaskSummary { summary }
        | MemoryBody::Decision { summary }
        | MemoryBody::VerifiedOutcome { summary } => summary.clone(),
        MemoryBody::MessageEvidence { reference, note }
        | MemoryBody::TaskEventEvidence { reference, note }
        | MemoryBody::ArtifactEvidence { reference, note }
        | MemoryBody::ReceiptEvidence { reference, note } => {
            join([Some(reference.as_str()), note.as_deref()])
        }
        MemoryBody::WorkflowCandidate { name, summary }
        | MemoryBody::SkillCandidate { name, summary } => format!("{name}：{summary}"),
    };
    truncate_summary(&text)
}

fn join<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> String {
    parts.into_iter().flatten().collect::<Vec<_>>().join(" ")
}

fn truncate_summary(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = if collapsed.is_empty() {
        "（无正文）".to_owned()
    } else {
        collapsed
    };
    if collapsed.chars().count() <= SUMMARY_CHARS {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(SUMMARY_CHARS).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_storage::{
        MemoryWriteCandidate, PersonalityDraft, PersonalityRecord, StorageError,
    };

    fn open() -> Storage {
        Storage::open_in_memory().expect("memory database should open")
    }

    fn personality(identity: &str) -> PersonalityDraft {
        PersonalityDraft {
            identity: identity.to_owned(),
            tone: "平静".to_owned(),
            verbosity: "简短".to_owned(),
            language: "zh-CN".to_owned(),
            initiative: "低".to_owned(),
            behavior_boundary: "先确认外部副作用".to_owned(),
            tool_policy: "只读默认可执行".to_owned(),
            voice: "不自动播报后台任务".to_owned(),
            evolution_note: None,
            active: true,
        }
    }

    fn input(key: &str, value: &str) -> UserPreferenceInput {
        UserPreferenceInput {
            key: key.to_owned(),
            value: value.to_owned(),
        }
    }

    fn versions(storage: &Storage) -> Vec<PersonalityRecord> {
        storage
            .list_personality_versions("persona_local")
            .expect("personality versions should load")
    }

    #[test]
    fn user_can_create_edit_and_delete_a_preference_without_touching_persona() {
        let mut storage = open();
        let empty = list_client_memory(&storage).unwrap();
        assert!(empty.preferences.is_empty());
        assert!(empty.memories.is_empty());
        assert!(empty.persona.is_none());

        storage
            .create_personality(
                MemoryActor::User,
                "persona_local",
                &personality("Semi 助手"),
                1,
            )
            .unwrap();
        let persona_before = versions(&storage);
        storage
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "mem_repo".into(),
                    body: MemoryBody::ProjectFact {
                        fact: "仓库使用 pnpm".into(),
                    },
                    scope: local_scope(),
                    sources: vec![NewMemorySource {
                        source_id: "src_mem_repo".into(),
                        kind: MemorySourceKind::Task,
                        source_ref: "task_repo".into(),
                        note: None,
                    }],
                },
                2,
            )
            .unwrap();
        storage
            .create_memory(
                MemoryActor::System,
                &NewMemory {
                    memory_id: "rule_confirm".into(),
                    body: MemoryBody::SafetyRule {
                        statement: "外部副作用需要确认".into(),
                    },
                    scope: local_scope(),
                    sources: vec![],
                },
                3,
            )
            .unwrap();

        let created = create_user_preference(&mut storage, &input("语气", "活泼"), 10).unwrap();
        let preference = created
            .preferences
            .iter()
            .find(|row| row.key == "语气")
            .expect("created preference should be listed");
        assert_eq!(preference.value, "活泼");
        assert_eq!(preference.author, MemoryAuthor::User);
        assert_eq!(preference.mutability, MemoryMutability::UserReadonly);
        assert!(created
            .memories
            .iter()
            .all(|row| row.memory_id != preference.memory_id));
        let agent = created
            .memories
            .iter()
            .find(|row| row.memory_id == "mem_repo")
            .expect("agent memory should be visible");
        assert_eq!(agent.author, MemoryAuthor::Agent);
        assert_eq!(agent.mutability, MemoryMutability::AgentMutable);
        assert_eq!(agent.summary, "仓库使用 pnpm");
        let system = created
            .memories
            .iter()
            .find(|row| row.memory_id == "rule_confirm")
            .expect("system memory should be visible");
        assert_eq!(system.author, MemoryAuthor::System);
        assert_eq!(system.mutability, MemoryMutability::SystemReadonly);
        let persona = created.persona.expect("persona fingerprint should load");
        assert_eq!(persona.personality_id, "persona_local");
        assert_eq!(persona.version, 1);
        assert_eq!(persona.author, MemoryAuthor::User);
        assert_eq!(persona.mutability, MemoryMutability::UserReadonly);

        let revised = revise_user_preference(
            &mut storage,
            &preference.memory_id,
            &input("语气", "克制"),
            11,
        )
        .unwrap();
        let revised_row = revised
            .preferences
            .iter()
            .find(|row| row.memory_id == preference.memory_id)
            .unwrap();
        assert_eq!(revised_row.value, "克制");
        assert_eq!(revised_row.author, MemoryAuthor::User);
        assert_eq!(
            storage.load_compact_persona().unwrap().unwrap().tone,
            "平静"
        );

        let deleted = delete_user_preference(&mut storage, &preference.memory_id).unwrap();
        assert!(deleted
            .preferences
            .iter()
            .all(|row| row.memory_id != preference.memory_id));
        assert!(deleted
            .memories
            .iter()
            .any(|row| row.memory_id == "mem_repo"));
        assert_eq!(versions(&storage), persona_before);
        assert!(!storage
            .load_compact_persona()
            .unwrap()
            .unwrap()
            .text
            .contains("活泼"));
        assert!(!storage
            .load_compact_persona()
            .unwrap()
            .unwrap()
            .text
            .contains("克制"));
    }

    #[test]
    fn client_commands_cannot_rewrite_agent_or_system_rows() {
        let mut storage = open();
        storage
            .write_memory(
                MemoryActor::Agent,
                &MemoryWriteCandidate {
                    memory_id: "mem_font".into(),
                    body: MemoryBody::Preference {
                        key: "font".into(),
                        value: "sans".into(),
                    },
                    scope: local_scope(),
                    sources: vec![NewMemorySource {
                        source_id: "src_mem_font".into(),
                        kind: MemorySourceKind::ConversationTurn,
                        source_ref: "turn_font".into(),
                        note: None,
                    }],
                    confidence: 80,
                    importance: 40,
                    conflict: None,
                },
                20,
            )
            .unwrap();
        let before = storage.load_memory("mem_font").unwrap().unwrap();
        let revise_error =
            revise_user_preference(&mut storage, "mem_font", &input("font", "serif"), 21);
        assert!(matches!(
            revise_error,
            Err(StorageError::OwnershipDenied {
                actor: "user",
                author: "agent",
                ..
            })
        ));
        let delete_error = delete_user_preference(&mut storage, "mem_font");
        assert!(matches!(
            delete_error,
            Err(StorageError::OwnershipDenied {
                author: "agent",
                ..
            })
        ));
        assert_eq!(storage.load_memory("mem_font").unwrap().unwrap(), before);
        assert_eq!(
            client_memory_message(&StorageError::OwnershipDenied {
                actor: "user",
                record_class: "偏好",
                author: "agent",
            }),
            "这条记录不能由当前操作修改"
        );
        assert_eq!(
            client_memory_message(&StorageError::InvalidMemory("password=hunter2".into())),
            "偏好内容无效"
        );
    }

    #[test]
    fn agent_still_cannot_modify_a_preference_created_from_the_client() {
        let mut storage = open();
        storage
            .create_personality(
                MemoryActor::User,
                "persona_local",
                &personality("Semi 助手"),
                1,
            )
            .unwrap();
        let persona_before = versions(&storage);
        let created = create_user_preference(&mut storage, &input("font", "serif"), 30).unwrap();
        let memory_id = created.preferences[0].memory_id.clone();
        let before = storage.load_memory(&memory_id).unwrap().unwrap();
        let revise_error = storage.revise_memory(
            MemoryActor::Agent,
            &memory_id,
            &MemoryRevision {
                body: MemoryBody::Preference {
                    key: "font".into(),
                    value: "sans".into(),
                },
                scope: before.scope.clone(),
            },
            31,
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
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                author: "user",
                ..
            })
        ));
        assert_eq!(storage.load_memory(&memory_id).unwrap().unwrap(), before);
        assert_eq!(versions(&storage), persona_before);
    }

    #[test]
    fn duplicate_preference_keys_do_not_overwrite() {
        let mut storage = open();
        let created = create_user_preference(&mut storage, &input(" Theme ", "light"), 40).unwrap();
        let original = created.preferences[0].clone();
        assert_eq!(original.key, "Theme");
        let duplicate = create_user_preference(&mut storage, &input("theme", "dark"), 41);
        let Err(error) = duplicate else {
            panic!("duplicate preference should be rejected");
        };
        assert!(matches!(
            &error,
            StorageError::InvalidMemory(message) if message == DUPLICATE_PREFERENCE
        ));
        assert_eq!(client_memory_message(&error), DUPLICATE_PREFERENCE);
        let page = list_client_memory(&storage).unwrap();
        assert_eq!(page.preferences, vec![original]);
    }
}
