//! 客户端记忆页的 Host 命令。
//!
//! WebView 不能打开 SQLite，也不能自己指定调用者。这里固定以用户身份写入。
//! 用户可以维护自己的偏好；Agent 学到的项目、任务和未验证工作流在同一页按种类
//! 分开，并带来源、范围、作者、更新时间、最近召回和冲突。纠正 Agent 记录时新增
//! 一条用户记录并 supersede，不改 Agent 原文。停用和忘记只改变生效状态。
//! 这些动作写入记忆动态，不产生语音事件。
//!
//! 人格表只读出版本指纹：偏好写入不调用人格接口，避免用户偏好被静默写成人格定义。
//! 这一页是本机库的归属视图，不是 Agent 的范围检索。损坏记录必须让整页失败。

use semi_os_storage::{
    MemoryActivityKind, MemoryActor, MemoryAuthor, MemoryBody, MemoryEffectSnapshot,
    MemoryEffectStatus, MemoryLayer, MemoryLink, MemoryMutability, MemoryQuery, MemoryRecord,
    MemoryRecordKind, MemoryRelation, MemoryRevision, MemoryScope, MemorySource, MemorySourceKind,
    NewMemory, NewMemoryLink, NewMemorySource, Storage, StorageError, StorageResult,
};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// 本机客户端写入偏好时使用的用户范围。界面不能改这个身份。
pub const CLIENT_USER_ID: &str = "local";

const DUPLICATE_PREFERENCE: &str = "同一范围已有这个偏好，请直接编辑";
const OWN_PREFERENCE_ONLY: &str = "只能修改自己的偏好";
const NOT_CORRECTABLE: &str = "这条记录不能纠正";
const CORRECTION_INVALID: &str = "纠正内容无效";
const RESTORE_FIRST: &str = "请先恢复这条记录";
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

/// 当前生效人格的指纹。不含语气正文，避免和偏好值混在同一个可编辑字段里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPersonaFingerprint {
    pub personality_id: String,
    pub version: i64,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
}

/// 记忆页上的种类。界面按这个分节，不靠模型散文归类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientMemorySectionId {
    UserSettings,
    AgentLearned,
    ProjectApplication,
    TaskExperience,
    UnverifiedWorkflow,
    Other,
}

impl ClientMemorySectionId {
    const fn ordered() -> [Self; 5] {
        [
            Self::UserSettings,
            Self::AgentLearned,
            Self::ProjectApplication,
            Self::TaskExperience,
            Self::UnverifiedWorkflow,
        ]
    }
}

/// 这条记录现在为什么没有、或者仍会进入后续召回。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientMemoryStatus {
    Active,
    Disabled,
    Forgotten,
    Superseded,
    ConflictInactive,
}

/// 来源指针。界面只展示这些字段，不打开原始会话库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemorySource {
    pub source_id: String,
    pub kind: MemorySourceKind,
    pub source_ref: String,
    pub note: Option<String>,
    pub created_at_ms: i64,
}

/// 用户可以执行的动作。系统记录只有查看来源；Agent 不能借这些标志改用户原文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryActions {
    pub correct: bool,
    pub disable: bool,
    pub forget: bool,
    pub view_source: bool,
    pub restore: bool,
}

/// 记忆页上的一条可解释记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryItem {
    pub memory_id: String,
    pub section: ClientMemorySectionId,
    pub layer: MemoryLayer,
    pub record_kind: MemoryRecordKind,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference_value: Option<String>,
    pub sources: Vec<ClientMemorySource>,
    pub scope_label: String,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
    pub updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_recalled_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall_reason: Option<String>,
    pub status: ClientMemoryStatus,
    pub has_conflict: bool,
    pub actions: ClientMemoryActions,
}

/// 一个固定分节。五个主要分节始终出现，空列表也保留，避免界面把种类藏起来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemorySection {
    pub id: ClientMemorySectionId,
    pub items: Vec<ClientMemoryItem>,
}

/// 记忆动态。只在记忆页展示，不进入语音。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryActivity {
    pub activity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    pub kind: MemoryActivityKind,
    pub summary: String,
    pub created_at_ms: i64,
}

/// 记忆页快照。写操作返回整页，界面用它替换本地状态，而不是自行打补丁。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientMemoryPage {
    pub preferences: Vec<ClientPreferenceRow>,
    pub sections: Vec<ClientMemorySection>,
    pub forgotten: Vec<ClientMemoryItem>,
    pub activity: Vec<ClientMemoryActivity>,
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
            NOT_CORRECTABLE => NOT_CORRECTABLE,
            CORRECTION_INVALID => CORRECTION_INVALID,
            RESTORE_FIRST => RESTORE_FIRST,
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

/// 偏好删除改为可恢复的忘记。旧行和原文都留在库里，Agent 仍然不能改它们。
pub fn delete_user_preference(
    storage: &mut Storage,
    memory_id: &str,
) -> StorageResult<ClientMemoryPage> {
    require_user_preference(storage, memory_id)?;
    storage.set_memory_effect(
        MemoryActor::User,
        memory_id,
        MemoryEffectStatus::Forgotten,
        unix_fallback_now(),
    )?;
    page(storage)
}

/// 用户提交的纠正正文。只替换这条记录的主要文本，不改种类和范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryCorrectionInput {
    pub text: String,
}

/// 纠正一条错误记忆。用户自己的记录就地更新；Agent 记录保留原文，另写一条用户记录取代它。
pub fn correct_client_memory(
    storage: &mut Storage,
    memory_id: &str,
    input: &MemoryCorrectionInput,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    match correct_memory(storage, memory_id, input, now) {
        Ok(()) => page(storage),
        Err(StorageError::InvalidMemory(message))
            if message != NOT_CORRECTABLE && message != RESTORE_FIRST =>
        {
            Err(StorageError::InvalidMemory(CORRECTION_INVALID.to_owned()))
        }
        Err(error) => Err(error),
    }
}

pub fn disable_client_memory(
    storage: &mut Storage,
    memory_id: &str,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    storage.set_memory_effect(
        MemoryActor::User,
        memory_id,
        MemoryEffectStatus::Disabled,
        now,
    )?;
    page(storage)
}

pub fn forget_client_memory(
    storage: &mut Storage,
    memory_id: &str,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    storage.set_memory_effect(
        MemoryActor::User,
        memory_id,
        MemoryEffectStatus::Forgotten,
        now,
    )?;
    page(storage)
}

pub fn restore_client_memory(
    storage: &mut Storage,
    memory_id: &str,
    now: i64,
) -> StorageResult<ClientMemoryPage> {
    storage.set_memory_effect(
        MemoryActor::User,
        memory_id,
        MemoryEffectStatus::Active,
        now,
    )?;
    page(storage)
}

fn correct_memory(
    storage: &mut Storage,
    memory_id: &str,
    input: &MemoryCorrectionInput,
    now: i64,
) -> StorageResult<()> {
    if now < 0 {
        return Err(StorageError::InvalidMemory("时间不能为负".into()));
    }
    let existing = storage
        .load_memory(memory_id)?
        .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
    if existing.author == MemoryAuthor::System {
        return Err(StorageError::OwnershipDenied {
            actor: "user",
            record_class: "记忆",
            author: "system",
        });
    }
    if storage.memory_effect(memory_id)?.status == MemoryEffectStatus::Forgotten {
        return Err(StorageError::InvalidMemory(RESTORE_FIRST.to_owned()));
    }
    let body = corrected_body(&existing.body, &input.text)?;
    if existing.author == MemoryAuthor::User {
        storage.revise_memory(
            MemoryActor::User,
            memory_id,
            &MemoryRevision {
                body,
                scope: existing.scope,
            },
            now,
        )?;
        attach_correction_source(storage, memory_id, now)?;
    } else if let Some(key) = preference_key(&body) {
        if let Some(user_row) = user_preference_with_key(storage, &key)? {
            storage.revise_memory(
                MemoryActor::User,
                &user_row.memory_id,
                &MemoryRevision {
                    body,
                    scope: user_row.scope.clone(),
                },
                now,
            )?;
            storage.set_memory_effect(
                MemoryActor::User,
                &user_row.memory_id,
                MemoryEffectStatus::Active,
                now,
            )?;
            attach_correction_source(storage, &user_row.memory_id, now)?;
            supersede(storage, &user_row.memory_id, memory_id, now)?;
        } else {
            replace_with_user_correction(storage, &body, &existing.scope, memory_id, now)?;
        }
    } else {
        replace_with_user_correction(storage, &body, &existing.scope, memory_id, now)?;
    }
    storage.record_memory_activity(
        Some(memory_id),
        MemoryActivityKind::Corrected,
        "已纠正一条记忆",
        now,
    )?;
    Ok(())
}

fn page(storage: &Storage) -> StorageResult<ClientMemoryPage> {
    let records = storage.list_memories(&MemoryQuery::default())?;
    let effects = storage.memory_effects()?;
    let inactive = storage.recall_inactive_ids()?;
    let mut preferences = Vec::new();
    let mut grouped: Vec<(ClientMemorySectionId, ClientMemoryItem)> = Vec::new();
    let mut forgotten = Vec::new();
    for record in records {
        let effect = effects.get(&record.memory_id).cloned().unwrap_or_default();
        let links = storage.list_memory_links(&record.memory_id)?;
        let sources = storage.list_memory_sources(&record.memory_id)?;
        let item = memory_item(&record, &effect, &links, &sources, &inactive)?;
        if item.status == ClientMemoryStatus::Forgotten {
            forgotten.push(item);
            continue;
        }
        if record.author == MemoryAuthor::User && record.record_kind == MemoryRecordKind::Preference
        {
            preferences.push(preference_row(&record)?);
        }
        grouped.push((item.section, item));
    }
    sort_items(&mut preferences);
    sort_memory_items(&mut forgotten);
    let mut sections = Vec::new();
    for id in ClientMemorySectionId::ordered() {
        let mut items: Vec<_> = grouped
            .iter()
            .filter(|(section, _)| *section == id)
            .map(|(_, item)| item.clone())
            .collect();
        sort_memory_items(&mut items);
        sections.push(ClientMemorySection { id, items });
    }
    let mut other: Vec<_> = grouped
        .into_iter()
        .filter(|(section, _)| *section == ClientMemorySectionId::Other)
        .map(|(_, item)| item)
        .collect();
    if !other.is_empty() {
        sort_memory_items(&mut other);
        sections.push(ClientMemorySection {
            id: ClientMemorySectionId::Other,
            items: other,
        });
    }
    let persona = storage
        .load_compact_persona()?
        .map(|persona| ClientPersonaFingerprint {
            personality_id: persona.personality_id,
            version: persona.version,
            author: persona.author,
            mutability: persona.mutability,
        });
    let activity = storage
        .list_memory_activity(30)?
        .into_iter()
        .map(|row| ClientMemoryActivity {
            activity_id: row.activity_id,
            memory_id: row.memory_id,
            kind: row.kind,
            summary: row.summary,
            created_at_ms: row.created_at_ms,
        })
        .collect();
    Ok(ClientMemoryPage {
        preferences,
        sections,
        forgotten,
        activity,
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

fn memory_item(
    record: &MemoryRecord,
    effect: &MemoryEffectSnapshot,
    links: &[MemoryLink],
    sources: &[MemorySource],
    inactive: &std::collections::HashSet<String>,
) -> StorageResult<ClientMemoryItem> {
    let (preference_key, preference_value) = match &record.body {
        MemoryBody::Preference { key, value } => (Some(key.clone()), Some(value.clone())),
        _ => (None, None),
    };
    let section = section_of(record);
    let superseded = links.iter().any(|link| {
        link.relation == MemoryRelation::Supersedes && link.to_memory_id == record.memory_id
    });
    let has_conflict = links
        .iter()
        .any(|link| link.relation == MemoryRelation::Contradicts);
    let status = match effect.status {
        MemoryEffectStatus::Forgotten => ClientMemoryStatus::Forgotten,
        MemoryEffectStatus::Disabled => ClientMemoryStatus::Disabled,
        MemoryEffectStatus::Active if superseded => ClientMemoryStatus::Superseded,
        MemoryEffectStatus::Active if inactive.contains(&record.memory_id) => {
            ClientMemoryStatus::ConflictInactive
        }
        MemoryEffectStatus::Active => ClientMemoryStatus::Active,
    };
    let system = record.author == MemoryAuthor::System;
    let forgotten = status == ClientMemoryStatus::Forgotten;
    let disabled = status == ClientMemoryStatus::Disabled;
    Ok(ClientMemoryItem {
        memory_id: record.memory_id.clone(),
        section,
        layer: record.layer,
        record_kind: record.record_kind,
        summary: summarize(&record.body),
        preference_key,
        preference_value,
        sources: sources
            .iter()
            .map(|source| ClientMemorySource {
                source_id: source.source_id.clone(),
                kind: source.kind,
                source_ref: source.source_ref.clone(),
                note: source.note.clone(),
                created_at_ms: source.created_at_ms,
            })
            .collect(),
        scope_label: scope_label(&record.scope),
        author: record.author,
        mutability: record.mutability,
        updated_at_ms: record.updated_at_ms,
        last_recalled_at_ms: effect.last_recalled_at_ms,
        recall_reason: effect.last_recall_reason.clone(),
        status,
        has_conflict,
        actions: ClientMemoryActions {
            correct: !system && !forgotten && correctable(record.record_kind),
            disable: !system && !forgotten && !disabled,
            forget: !system && !forgotten,
            view_source: true,
            restore: !system && (forgotten || disabled),
        },
    })
}

fn section_of(record: &MemoryRecord) -> ClientMemorySectionId {
    match (record.author, record.record_kind) {
        (MemoryAuthor::User, MemoryRecordKind::Preference | MemoryRecordKind::Profile) => {
            ClientMemorySectionId::UserSettings
        }
        (MemoryAuthor::Agent, MemoryRecordKind::Preference | MemoryRecordKind::Profile) => {
            ClientMemorySectionId::AgentLearned
        }
        (_, MemoryRecordKind::ProjectFact | MemoryRecordKind::ApplicationHabit) => {
            ClientMemorySectionId::ProjectApplication
        }
        (
            _,
            MemoryRecordKind::TaskSummary
            | MemoryRecordKind::Decision
            | MemoryRecordKind::VerifiedOutcome,
        ) => ClientMemorySectionId::TaskExperience,
        (_, MemoryRecordKind::WorkflowCandidate | MemoryRecordKind::SkillCandidate) => {
            ClientMemorySectionId::UnverifiedWorkflow
        }
        _ => ClientMemorySectionId::Other,
    }
}

fn correctable(kind: MemoryRecordKind) -> bool {
    matches!(
        kind,
        MemoryRecordKind::Preference
            | MemoryRecordKind::Profile
            | MemoryRecordKind::ProjectFact
            | MemoryRecordKind::ApplicationHabit
            | MemoryRecordKind::TaskSummary
            | MemoryRecordKind::Decision
            | MemoryRecordKind::VerifiedOutcome
            | MemoryRecordKind::WorkflowCandidate
            | MemoryRecordKind::SkillCandidate
    )
}

fn corrected_body(existing: &MemoryBody, text: &str) -> StorageResult<MemoryBody> {
    let text = text.trim();
    if text.is_empty() {
        return Err(StorageError::InvalidMemory(CORRECTION_INVALID.to_owned()));
    }
    let text = text.to_owned();
    match existing {
        MemoryBody::Preference { key, .. } => Ok(MemoryBody::Preference {
            key: key.clone(),
            value: text,
        }),
        MemoryBody::Profile { .. } => Ok(MemoryBody::Profile { fact: text }),
        MemoryBody::ProjectFact { .. } => Ok(MemoryBody::ProjectFact { fact: text }),
        MemoryBody::ApplicationHabit { application, .. } => Ok(MemoryBody::ApplicationHabit {
            application: application.clone(),
            habit: text,
        }),
        MemoryBody::TaskSummary { .. } => Ok(MemoryBody::TaskSummary { summary: text }),
        MemoryBody::Decision { .. } => Ok(MemoryBody::Decision { summary: text }),
        MemoryBody::VerifiedOutcome { .. } => Ok(MemoryBody::VerifiedOutcome { summary: text }),
        MemoryBody::WorkflowCandidate { name, .. } => Ok(MemoryBody::WorkflowCandidate {
            name: name.clone(),
            summary: text,
        }),
        MemoryBody::SkillCandidate { name, .. } => Ok(MemoryBody::SkillCandidate {
            name: name.clone(),
            summary: text,
        }),
        _ => Err(StorageError::InvalidMemory(NOT_CORRECTABLE.to_owned())),
    }
}

fn replace_with_user_correction(
    storage: &mut Storage,
    body: &MemoryBody,
    scope: &MemoryScope,
    target_id: &str,
    now: i64,
) -> StorageResult<()> {
    let created = create_user_correction(storage, body, scope, now)?;
    if let Err(error) = supersede(storage, &created, target_id, now) {
        // 关系没写成时，新行还没取代旧记忆。删掉它，避免两条同时生效。
        let _ = storage.delete_memory(MemoryActor::User, &created);
        return Err(error);
    }
    Ok(())
}

fn create_user_correction(
    storage: &mut Storage,
    body: &MemoryBody,
    scope: &MemoryScope,
    now: i64,
) -> StorageResult<String> {
    let memory_id = allocate_id(storage, "fix", now)?;
    let source_id = format!("src_{memory_id}");
    storage.create_memory(
        MemoryActor::User,
        &NewMemory {
            memory_id: memory_id.clone(),
            body: body.clone(),
            scope: scope.clone(),
            sources: vec![NewMemorySource {
                source_id,
                kind: MemorySourceKind::UserEntry,
                source_ref: format!("client-correction-{now}"),
                note: Some("用户纠正".to_owned()),
            }],
        },
        now,
    )?;
    Ok(memory_id)
}

fn supersede(
    storage: &mut Storage,
    from_memory_id: &str,
    to_memory_id: &str,
    now: i64,
) -> StorageResult<()> {
    if from_memory_id == to_memory_id {
        return Ok(());
    }
    let already = storage
        .list_memory_links(from_memory_id)?
        .iter()
        .any(|link| {
            link.relation == MemoryRelation::Supersedes && link.to_memory_id == to_memory_id
        });
    if already {
        return Ok(());
    }
    let link_id = allocate_id(storage, "ln", now)?;
    storage.link_memories(
        MemoryActor::User,
        &NewMemoryLink {
            link_id,
            from_memory_id: from_memory_id.to_owned(),
            to_memory_id: to_memory_id.to_owned(),
            relation: MemoryRelation::Supersedes,
        },
        now,
    )?;
    Ok(())
}

fn attach_correction_source(storage: &mut Storage, memory_id: &str, now: i64) -> StorageResult<()> {
    for seq in 0..8 {
        let suffix = if seq == 0 {
            now.to_string()
        } else {
            format!("{now}_{seq}")
        };
        let attached = storage.attach_memory_source(
            MemoryActor::User,
            memory_id,
            &NewMemorySource {
                source_id: format!("src_corr_{suffix}"),
                kind: MemorySourceKind::UserEntry,
                source_ref: format!("client-correction-{suffix}"),
                note: Some("用户纠正".to_owned()),
            },
            now,
        );
        match attached {
            Ok(_) => return Ok(()),
            Err(StorageError::InvalidMemory(message)) if message == "记忆来源已存在" => {
                continue
            }
            Err(error) => return Err(error),
        }
    }
    Err(StorageError::InvalidMemory("来源编号暂时不可用".into()))
}

fn user_preference_with_key(storage: &Storage, key: &str) -> StorageResult<Option<MemoryRecord>> {
    let records = storage.list_memories(&MemoryQuery {
        record_kind: Some(MemoryRecordKind::Preference),
        author: Some(MemoryAuthor::User),
        ..MemoryQuery::default()
    })?;
    Ok(records
        .into_iter()
        .find(|record| preference_key(&record.body).as_deref() == Some(key)))
}

fn allocate_id(storage: &Storage, prefix: &str, now: i64) -> StorageResult<String> {
    if now < 0 {
        return Err(StorageError::InvalidMemory("时间不能为负".into()));
    }
    for seq in 0..32 {
        let memory_id = if seq == 0 {
            format!("{prefix}_{now}")
        } else {
            format!("{prefix}_{now}_{seq}")
        };
        if storage.load_memory(&memory_id)?.is_none() {
            return Ok(memory_id);
        }
    }
    Err(StorageError::InvalidMemory("记忆编号暂时不可用".into()))
}

fn sort_items(rows: &mut [ClientPreferenceRow]) {
    rows.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
}

fn sort_memory_items(rows: &mut [ClientMemoryItem]) {
    rows.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
}

fn scope_label(scope: &MemoryScope) -> String {
    let mut parts = Vec::new();
    if let Some(user_id) = &scope.user_id {
        parts.push(format!("用户 {user_id}"));
    }
    if let Some(workspace_id) = &scope.workspace_id {
        parts.push(format!("工作区 {workspace_id}"));
    }
    if let Some(application_id) = &scope.application_id {
        parts.push(format!("应用 {application_id}"));
    }
    if let Some(task_id) = &scope.task_id {
        parts.push(format!("任务 {task_id}"));
    }
    if let Some(skill_id) = &scope.skill_id {
        parts.push(format!("技能 {skill_id}"));
    }
    if parts.is_empty() {
        "未限定范围".to_owned()
    } else {
        parts.join(" · ")
    }
}

fn unix_fallback_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
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

    fn section(page: &ClientMemoryPage, id: ClientMemorySectionId) -> Vec<ClientMemoryItem> {
        page.sections
            .iter()
            .find(|section| section.id == id)
            .map(|section| section.items.clone())
            .unwrap_or_default()
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
        assert_eq!(empty.sections.len(), 5);
        assert!(empty
            .sections
            .iter()
            .all(|section| section.items.is_empty()));
        assert!(empty.forgotten.is_empty());
        assert!(empty.activity.is_empty());
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
        let settings = section(&created, ClientMemorySectionId::UserSettings);
        assert!(settings
            .iter()
            .any(|row| row.memory_id == preference.memory_id));
        assert!(settings
            .iter()
            .all(|row| row.section == ClientMemorySectionId::UserSettings));
        let agent = section(&created, ClientMemorySectionId::ProjectApplication)
            .into_iter()
            .find(|row| row.memory_id == "mem_repo")
            .expect("project experience should be visible");
        assert_eq!(agent.author, MemoryAuthor::Agent);
        assert_eq!(agent.mutability, MemoryMutability::AgentMutable);
        assert_eq!(agent.summary, "仓库使用 pnpm");
        assert_eq!(agent.scope_label, "用户 local");
        assert!(agent
            .sources
            .iter()
            .any(|source| source.source_ref == "task_repo"));
        assert_eq!(agent.status, ClientMemoryStatus::Active);
        assert!(!agent.has_conflict);
        assert!(agent.last_recalled_at_ms.is_none());
        assert!(agent.actions.correct && agent.actions.disable && agent.actions.forget);
        assert!(!agent.actions.restore);
        let system = section(&created, ClientMemorySectionId::Other)
            .into_iter()
            .find(|row| row.memory_id == "rule_confirm")
            .expect("system memory should stay visible");
        assert_eq!(system.author, MemoryAuthor::System);
        assert_eq!(system.mutability, MemoryMutability::SystemReadonly);
        assert!(!system.actions.correct);
        assert!(!system.actions.disable);
        assert!(!system.actions.forget);
        assert!(system.actions.view_source);
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
        let forgotten = deleted
            .forgotten
            .iter()
            .find(|row| row.memory_id == preference.memory_id)
            .expect("accidental deletion should be restorable");
        assert_eq!(forgotten.status, ClientMemoryStatus::Forgotten);
        assert!(forgotten.actions.restore);
        assert!(!forgotten.actions.forget);
        assert_eq!(
            storage
                .load_memory(&preference.memory_id)
                .unwrap()
                .unwrap()
                .body,
            MemoryBody::Preference {
                key: "语气".into(),
                value: "克制".into(),
            }
        );
        assert!(section(&deleted, ClientMemorySectionId::ProjectApplication)
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

    #[test]
    fn user_can_explain_and_stop_a_wrong_memory_without_letting_the_agent_edit_it() {
        let mut storage = open();
        storage
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "fact_wrong".into(),
                    body: MemoryBody::ProjectFact {
                        fact: "仓库使用 npm".into(),
                    },
                    scope: local_scope(),
                    sources: vec![NewMemorySource {
                        source_id: "src_fact_wrong".into(),
                        kind: MemorySourceKind::Task,
                        source_ref: "task_wrong".into(),
                        note: Some("来自任务回执".into()),
                    }],
                },
                50,
            )
            .unwrap();
        storage
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "flow_unverified".into(),
                    body: MemoryBody::WorkflowCandidate {
                        name: "发布".into(),
                        summary: "还没有验证".into(),
                    },
                    scope: local_scope(),
                    sources: vec![NewMemorySource {
                        source_id: "src_flow".into(),
                        kind: MemorySourceKind::Task,
                        source_ref: "task_flow".into(),
                        note: None,
                    }],
                },
                51,
            )
            .unwrap();
        storage
            .link_memories(
                MemoryActor::Agent,
                &NewMemoryLink {
                    link_id: "ln_conflict".into(),
                    from_memory_id: "flow_unverified".into(),
                    to_memory_id: "fact_wrong".into(),
                    relation: MemoryRelation::Contradicts,
                },
                52,
            )
            .unwrap();

        let listed = list_client_memory(&storage).unwrap();
        assert!(section(&listed, ClientMemorySectionId::AgentLearned).is_empty());
        let project = section(&listed, ClientMemorySectionId::ProjectApplication);
        let task = section(&listed, ClientMemorySectionId::TaskExperience);
        let workflow = section(&listed, ClientMemorySectionId::UnverifiedWorkflow);
        assert_eq!(project.len(), 1);
        assert!(task.is_empty());
        assert_eq!(workflow[0].memory_id, "flow_unverified");
        assert_eq!(workflow[0].summary, "发布：还没有验证");
        let wrong = &project[0];
        assert!(wrong.has_conflict);
        assert_eq!(wrong.sources[0].source_ref, "task_wrong");
        assert_eq!(wrong.recall_reason, None);

        let agent_before = storage.load_memory("fact_wrong").unwrap().unwrap();
        let corrected = correct_client_memory(
            &mut storage,
            "fact_wrong",
            &MemoryCorrectionInput {
                text: "仓库使用 pnpm".into(),
            },
            53,
        )
        .unwrap();
        assert_eq!(
            storage.load_memory("fact_wrong").unwrap().unwrap().body,
            agent_before.body
        );
        let replacement = section(&corrected, ClientMemorySectionId::ProjectApplication)
            .into_iter()
            .find(|row| row.author == MemoryAuthor::User)
            .expect("correction should be a user-owned project experience");
        assert_eq!(replacement.summary, "仓库使用 pnpm");
        assert_eq!(replacement.mutability, MemoryMutability::UserReadonly);
        assert!(replacement.sources.iter().any(|source| {
            source.kind == MemorySourceKind::UserEntry && source.note.as_deref() == Some("用户纠正")
        }));
        let superseded = section(&corrected, ClientMemorySectionId::ProjectApplication)
            .into_iter()
            .find(|row| row.memory_id == "fact_wrong")
            .unwrap();
        assert_eq!(superseded.status, ClientMemoryStatus::Superseded);
        let agent_edit = storage.revise_memory(
            MemoryActor::Agent,
            &replacement.memory_id,
            &MemoryRevision {
                body: MemoryBody::ProjectFact {
                    fact: "仓库使用 yarn".into(),
                },
                scope: local_scope(),
            },
            54,
        );
        assert!(matches!(
            agent_edit,
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                author: "user",
                ..
            })
        ));
        let agent_effect = storage.set_memory_effect(
            MemoryActor::Agent,
            &replacement.memory_id,
            MemoryEffectStatus::Forgotten,
            55,
        );
        assert!(matches!(
            agent_effect,
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                author: "user",
                ..
            })
        ));

        let before_disable = crate::memory_context::build_turn_memory_context(&storage)
            .unwrap()
            .unwrap_or_default();
        assert!(before_disable.contains("仓库使用 pnpm"));
        disable_client_memory(&mut storage, &replacement.memory_id, 56).unwrap();
        let context = crate::memory_context::build_turn_memory_context(&storage)
            .unwrap()
            .unwrap_or_default();
        assert!(!context.contains("仓库使用 pnpm"));
        assert!(!context.contains("仓库使用 npm"));

        forget_client_memory(&mut storage, "flow_unverified", 57).unwrap();
        let forgotten = list_client_memory(&storage).unwrap();
        assert!(section(&forgotten, ClientMemorySectionId::UnverifiedWorkflow).is_empty());
        assert!(forgotten
            .forgotten
            .iter()
            .any(|row| row.memory_id == "flow_unverified" && row.actions.restore));
        let restored = restore_client_memory(&mut storage, "flow_unverified", 58).unwrap();
        let restored_flow = section(&restored, ClientMemorySectionId::UnverifiedWorkflow);
        assert_eq!(restored_flow[0].status, ClientMemoryStatus::Active);
        assert!(restored
            .activity
            .iter()
            .any(|row| row.kind == MemoryActivityKind::Corrected));
        assert!(restored
            .activity
            .iter()
            .all(|row| !row.summary.contains("voice.")));
        let system_disable = disable_client_memory(&mut storage, "rule_missing", 59);
        assert!(system_disable.is_err());
    }
}
