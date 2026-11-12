//! 记忆是否仍对召回生效，以及客户端可见的记忆动态。
//!
//! 正文和作者留在 `memories`。停用、忘记和恢复只改这里的状态，因此用户或
//! Agent 的原文不会被控制动作覆盖。忘记是软删除：行还在，记忆页可以恢复。
//! 召回时间只说明上一次被装进记忆包的原因，不产生语音事件。

use crate::{MemoryActor, MemoryAuthor, Storage, StorageError, StorageResult};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_REASON_CHARS: usize = 40;
const MAX_SUMMARY_CHARS: usize = 160;

/// 一条记忆对后续召回是否生效。缺省行等同于 [`MemoryEffectStatus::Active`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEffectStatus {
    Active,
    Disabled,
    Forgotten,
}

impl MemoryEffectStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Disabled => "disabled",
            Self::Forgotten => "forgotten",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "active" => Ok(Self::Active),
            "disabled" => Ok(Self::Disabled),
            "forgotten" => Ok(Self::Forgotten),
            other => Err(StorageError::InvalidEnum {
                kind: "memory effect",
                value: other.to_owned(),
            }),
        }
    }
}

/// 客户端记忆动态的种类。这些记录不进入 `voice.*`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryActivityKind {
    Recalled,
    Written,
    Corrected,
    Disabled,
    Forgotten,
    Restored,
    WriteFailed,
}

impl MemoryActivityKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recalled => "recalled",
            Self::Written => "written",
            Self::Corrected => "corrected",
            Self::Disabled => "disabled",
            Self::Forgotten => "forgotten",
            Self::Restored => "restored",
            Self::WriteFailed => "write_failed",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "recalled" => Ok(Self::Recalled),
            "written" => Ok(Self::Written),
            "corrected" => Ok(Self::Corrected),
            "disabled" => Ok(Self::Disabled),
            "forgotten" => Ok(Self::Forgotten),
            "restored" => Ok(Self::Restored),
            "write_failed" => Ok(Self::WriteFailed),
            other => Err(StorageError::InvalidEnum {
                kind: "memory activity",
                value: other.to_owned(),
            }),
        }
    }
}

/// 生效状态和最近一次召回。没有行时视为仍生效、尚未召回。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEffectSnapshot {
    pub status: MemoryEffectStatus,
    pub last_recalled_at_ms: Option<i64>,
    pub last_recall_reason: Option<String>,
}

impl Default for MemoryEffectSnapshot {
    fn default() -> Self {
        Self {
            status: MemoryEffectStatus::Active,
            last_recalled_at_ms: None,
            last_recall_reason: None,
        }
    }
}

/// 一次实际装进记忆包的记录，以及这次装入的确定性原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRecallNote {
    pub memory_id: String,
    pub reason: String,
}

/// 记忆页时间线上的一条动态。摘要不得携带秘密或语音原文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryActivityRecord {
    pub activity_id: String,
    pub memory_id: Option<String>,
    pub kind: MemoryActivityKind,
    pub summary: String,
    pub created_at_ms: i64,
}

impl Storage {
    pub fn memory_effect(&self, memory_id: &str) -> StorageResult<MemoryEffectSnapshot> {
        crate::memory::check_memory_id(memory_id, "记忆编号")?;
        Ok(self
            .memory_effects()?
            .get(memory_id)
            .cloned()
            .unwrap_or_default())
    }

    /// 一次读出全部生效行。没有出现的记忆仍视为生效。
    pub fn memory_effects(&self) -> StorageResult<HashMap<String, MemoryEffectSnapshot>> {
        let mut statement = self.connection.prepare(
            "SELECT memory_id, effect_status, last_recalled_at_ms, last_recall_reason
             FROM memory_effect",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut effects = HashMap::new();
        for row in rows {
            let (memory_id, status, last_recalled_at_ms, last_recall_reason) = row?;
            if last_recalled_at_ms.is_some_and(|value| value < 0) {
                return Err(StorageError::InvalidMemory(format!(
                    "召回时间损坏：{memory_id}"
                )));
            }
            effects.insert(
                memory_id,
                MemoryEffectSnapshot {
                    status: MemoryEffectStatus::parse(&status)?,
                    last_recalled_at_ms,
                    last_recall_reason,
                },
            );
        }
        Ok(effects)
    }

    /// 停用或忘记的记录。召回必须跳过它们，但重复检测仍能看见，避免停用后被写成新的生效副本。
    pub fn load_withheld_ids(&self) -> StorageResult<HashSet<String>> {
        let mut statement = self.connection.prepare(
            "SELECT memory_id FROM memory_effect WHERE effect_status IN ('disabled', 'forgotten')",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = HashSet::new();
        for memory_id in rows {
            ids.insert(memory_id?);
        }
        Ok(ids)
    }

    /// 改变生效状态。用户可以停用或忘记自己的记录，也可以停用 Agent 写错的记录。
    /// Agent 不能改变用户记录。系统记录不能从这条路径改掉。
    pub fn set_memory_effect(
        &mut self,
        actor: MemoryActor,
        memory_id: &str,
        status: MemoryEffectStatus,
        now: i64,
    ) -> StorageResult<()> {
        crate::memory::check_memory_id(memory_id, "记忆编号")?;
        if now < 0 {
            return Err(StorageError::InvalidMemory("时间不能为负".into()));
        }
        let record = self
            .load_memory(memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        ensure_effect_actor(actor, record.author)?;
        let current = self.memory_effect(memory_id)?.status;
        if current == status {
            return Ok(());
        }
        if !effect_transition_allowed(current, status) {
            return Err(StorageError::InvalidMemory("请先恢复这条记录".to_owned()));
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO memory_effect(
                memory_id, effect_status, last_recalled_at_ms, last_recall_reason, updated_at_ms
             ) VALUES (?1, ?2, NULL, NULL, ?3)
             ON CONFLICT(memory_id) DO UPDATE SET
                effect_status = excluded.effect_status,
                updated_at_ms = excluded.updated_at_ms",
            params![memory_id, status.as_str(), now],
        )?;
        let (kind, summary) = match status {
            MemoryEffectStatus::Disabled => (MemoryActivityKind::Disabled, "已停用，不再召回"),
            MemoryEffectStatus::Forgotten => (MemoryActivityKind::Forgotten, "已忘记，可以恢复"),
            MemoryEffectStatus::Active => (MemoryActivityKind::Restored, "已恢复生效"),
        };
        insert_activity(&transaction, Some(memory_id), kind, summary, now)?;
        transaction.commit()?;
        Ok(())
    }

    /// 记下这一轮真正装入记忆包的记录。不改正文，也不把已停用的记录重新打开。
    pub fn note_memory_recall(
        &mut self,
        notes: &[MemoryRecallNote],
        now: i64,
    ) -> StorageResult<()> {
        if now < 0 {
            return Err(StorageError::InvalidMemory("时间不能为负".into()));
        }
        let mut unique: HashMap<String, String> = HashMap::new();
        for note in notes {
            crate::memory::check_memory_id(&note.memory_id, "记忆编号")?;
            unique.insert(note.memory_id.clone(), clean_reason(&note.reason));
        }
        if unique.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.transaction()?;
        let mut applied = Vec::new();
        let mut recalled = 0usize;
        for (memory_id, reason) in &unique {
            let exists = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM memories WHERE memory_id = ?1)",
                    [memory_id],
                    |row| row.get::<_, bool>(0),
                )
                .optional()?
                .unwrap_or(false);
            if !exists {
                continue;
            }
            let withheld = transaction
                .query_row(
                    "SELECT effect_status FROM memory_effect WHERE memory_id = ?1",
                    [memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if withheld
                .as_deref()
                .is_some_and(|status| status != MemoryEffectStatus::Active.as_str())
            {
                continue;
            }
            transaction.execute(
                "INSERT INTO memory_effect(
                    memory_id, effect_status, last_recalled_at_ms, last_recall_reason, updated_at_ms
                 ) VALUES (?1, 'active', ?2, ?3, ?2)
                 ON CONFLICT(memory_id) DO UPDATE SET
                    last_recalled_at_ms = excluded.last_recalled_at_ms,
                    last_recall_reason = excluded.last_recall_reason,
                    updated_at_ms = excluded.updated_at_ms",
                params![memory_id, now, reason],
            )?;
            applied.push(reason.clone());
            recalled += 1;
        }
        if recalled == 0 {
            transaction.commit()?;
            return Ok(());
        }
        applied.sort();
        applied.dedup();
        let summary = format!("召回了 {recalled} 条：{}", applied.join("、"));
        insert_activity(
            &transaction,
            None,
            MemoryActivityKind::Recalled,
            &summary,
            now,
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// 追加一条客户端动态。`memory_id` 可以指向尚未落库的失败候选。
    pub fn record_memory_activity(
        &mut self,
        memory_id: Option<&str>,
        kind: MemoryActivityKind,
        summary: &str,
        now: i64,
    ) -> StorageResult<()> {
        if now < 0 {
            return Err(StorageError::InvalidMemory("时间不能为负".into()));
        }
        if let Some(memory_id) = memory_id {
            crate::memory::check_memory_id(memory_id, "记忆编号")?;
        }
        let summary = clean_summary(summary);
        let transaction = self.connection.transaction()?;
        insert_activity(&transaction, memory_id, kind, &summary, now)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_memory_activity(&self, limit: usize) -> StorageResult<Vec<MemoryActivityRecord>> {
        if limit == 0 {
            return Err(StorageError::InvalidMemory("动态条数必须大于 0".into()));
        }
        let limit = i64::try_from(limit.min(100)).unwrap_or(100);
        let mut statement = self.connection.prepare(
            "SELECT activity_id, memory_id, kind, summary, created_at_ms
             FROM memory_activity
             ORDER BY created_at_ms DESC, activity_id DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (activity_id, memory_id, kind, summary, created_at_ms) = row?;
            records.push(MemoryActivityRecord {
                activity_id,
                memory_id,
                kind: MemoryActivityKind::parse(&kind)?,
                summary,
                created_at_ms,
            });
        }
        Ok(records)
    }
}

fn ensure_effect_actor(actor: MemoryActor, author: MemoryAuthor) -> StorageResult<()> {
    let allowed = matches!(
        (actor, author),
        (MemoryActor::User, MemoryAuthor::User | MemoryAuthor::Agent)
            | (MemoryActor::Agent, MemoryAuthor::Agent)
            | (MemoryActor::System, MemoryAuthor::System)
    );
    if allowed {
        Ok(())
    } else {
        Err(StorageError::OwnershipDenied {
            actor: actor.as_str(),
            record_class: "记忆",
            author: author.as_str(),
        })
    }
}

fn effect_transition_allowed(current: MemoryEffectStatus, next: MemoryEffectStatus) -> bool {
    matches!(
        (current, next),
        (MemoryEffectStatus::Active, MemoryEffectStatus::Disabled)
            | (MemoryEffectStatus::Active, MemoryEffectStatus::Forgotten)
            | (MemoryEffectStatus::Disabled, MemoryEffectStatus::Forgotten)
            | (MemoryEffectStatus::Disabled, MemoryEffectStatus::Active)
            | (MemoryEffectStatus::Forgotten, MemoryEffectStatus::Active)
    )
}

fn clean_reason(reason: &str) -> String {
    let trimmed = reason.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_REASON_CHARS
        || trimmed.chars().any(char::is_control)
    {
        "召回".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn clean_summary(summary: &str) -> String {
    let trimmed = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return "记忆动态".to_owned();
    }
    if trimmed.chars().count() <= MAX_SUMMARY_CHARS {
        trimmed
    } else {
        let cut: String = trimmed.chars().take(MAX_SUMMARY_CHARS).collect();
        format!("{cut}…")
    }
}

fn insert_activity(
    connection: &rusqlite::Connection,
    memory_id: Option<&str>,
    kind: MemoryActivityKind,
    summary: &str,
    now: i64,
) -> StorageResult<()> {
    let summary = clean_summary(summary);
    for seq in 0..32 {
        let activity_id = if seq == 0 {
            format!("act_{now}_{}", kind.as_str())
        } else {
            format!("act_{now}_{}_{seq}", kind.as_str())
        };
        let changed = connection.execute(
            "INSERT INTO memory_activity(activity_id, memory_id, kind, summary, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![activity_id, memory_id, kind.as_str(), summary, now],
        );
        match changed {
            Ok(1) => return Ok(()),
            Ok(_) => {
                return Err(StorageError::InvalidMemory("记忆动态没有写入".into()));
            }
            Err(rusqlite::Error::SqliteFailure(code, _))
                if code.code == rusqlite::ErrorCode::ConstraintViolation
                    && matches!(code.extended_code, 2067 | 1555) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(StorageError::InvalidMemory("记忆动态编号暂时不可用".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MemoryBody, MemoryPackRequest, MemoryPackStage, MemoryRecallScope, MemoryRecordKind,
        MemoryScope, MemorySourceKind, NewMemory, NewMemorySource,
    };

    fn open() -> Storage {
        Storage::open_in_memory().expect("memory database should open")
    }

    fn preference(storage: &mut Storage, memory_id: &str, value: &str, now: i64) {
        storage
            .create_memory(
                MemoryActor::User,
                &NewMemory {
                    memory_id: memory_id.to_owned(),
                    body: MemoryBody::Preference {
                        key: "语气".into(),
                        value: value.into(),
                    },
                    scope: MemoryScope {
                        user_id: Some("local".into()),
                        ..MemoryScope::default()
                    },
                    sources: vec![NewMemorySource {
                        source_id: format!("src_{memory_id}"),
                        kind: MemorySourceKind::UserEntry,
                        source_ref: "client-preference".into(),
                        note: None,
                    }],
                },
                now,
            )
            .unwrap();
    }

    fn base_request() -> MemoryPackRequest {
        MemoryPackRequest {
            scope: MemoryRecallScope {
                user_id: "local".into(),
                workspace_id: None,
                application_id: None,
                task_id: None,
                skill_id: None,
            },
            stage: MemoryPackStage::Base,
            token_budget: 4_000,
            host_policy: "外部副作用需要确认".into(),
            query: String::new(),
            selected_memory_id: None,
        }
    }

    fn pack_contains(storage: &Storage, memory_id: &str) -> bool {
        storage
            .load_memory_pack(&base_request())
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.memory_id.as_deref() == Some(memory_id))
    }

    #[test]
    fn disable_and_forget_stop_recall_until_restore_without_rewriting_the_body() {
        let mut storage = open();
        preference(&mut storage, "pref_tone", "活泼", 1);
        let before = storage.load_memory("pref_tone").unwrap().unwrap();
        assert!(pack_contains(&storage, "pref_tone"));

        storage
            .set_memory_effect(
                MemoryActor::User,
                "pref_tone",
                MemoryEffectStatus::Disabled,
                2,
            )
            .unwrap();
        assert!(!pack_contains(&storage, "pref_tone"));
        assert_eq!(storage.load_memory("pref_tone").unwrap().unwrap(), before);
        assert_eq!(
            storage.memory_effect("pref_tone").unwrap().status,
            MemoryEffectStatus::Disabled
        );

        storage
            .set_memory_effect(
                MemoryActor::User,
                "pref_tone",
                MemoryEffectStatus::Forgotten,
                3,
            )
            .unwrap();
        assert!(!pack_contains(&storage, "pref_tone"));
        storage
            .set_memory_effect(
                MemoryActor::User,
                "pref_tone",
                MemoryEffectStatus::Active,
                4,
            )
            .unwrap();
        assert!(pack_contains(&storage, "pref_tone"));
        assert_eq!(storage.load_memory("pref_tone").unwrap().unwrap(), before);
        let activity = storage.list_memory_activity(10).unwrap();
        assert!(activity
            .iter()
            .any(|row| row.kind == MemoryActivityKind::Restored));
        assert!(activity
            .iter()
            .all(|row| row.kind != MemoryActivityKind::Recalled));
        assert_eq!(before.record_kind, MemoryRecordKind::Preference);
    }

    #[test]
    fn agent_cannot_change_the_effect_of_a_user_record() {
        let mut storage = open();
        preference(&mut storage, "pref_tone", "活泼", 1);
        let error = storage.set_memory_effect(
            MemoryActor::Agent,
            "pref_tone",
            MemoryEffectStatus::Forgotten,
            2,
        );
        assert!(matches!(
            error,
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                author: "user",
                ..
            })
        ));
        assert_eq!(
            storage.memory_effect("pref_tone").unwrap().status,
            MemoryEffectStatus::Active
        );
        assert!(pack_contains(&storage, "pref_tone"));
    }

    #[test]
    fn recall_note_records_reason_without_changing_text() {
        let mut storage = open();
        preference(&mut storage, "pref_tone", "活泼", 1);
        let before = storage.load_memory("pref_tone").unwrap().unwrap();
        storage
            .note_memory_recall(
                &[MemoryRecallNote {
                    memory_id: "pref_tone".into(),
                    reason: "基础包".into(),
                }],
                8,
            )
            .unwrap();
        assert_eq!(storage.load_memory("pref_tone").unwrap().unwrap(), before);
        let effect = storage.memory_effect("pref_tone").unwrap();
        assert_eq!(effect.last_recalled_at_ms, Some(8));
        assert_eq!(effect.last_recall_reason.as_deref(), Some("基础包"));
        let activity = storage.list_memory_activity(5).unwrap();
        assert_eq!(activity[0].kind, MemoryActivityKind::Recalled);
        assert!(activity[0].summary.contains("基础包"));
        assert!(!activity[0].summary.contains("voice"));
    }
}
