//! 六层记忆的持久化边界。
//!
//! `memories` 的每一行只属于一个层。层由记录种类决定，数据库 CHECK 与写入
//! 校验同时拒绝把压缩摘要写成 L2/L3，也拒绝把证据指针写成工作上下文。
//! L4 只保存证据引用，原始对话仍留在会话、任务事件和回执里，避免记忆表变成
//! transcript 堆。
//!
//! 来源在 `memory_sources`，关系在 `memory_links`。关系只表达
//! supersedes / contradicts / consolidates / associates，不构成图记忆，
//! 也不会在写入关系时改写另一条记录的正文。
//!
//! 作者和可变更性成对保存。用户创建的偏好，以及 `personality_records` 里的
//! 用户人格，都拒绝 Agent 改写；Agent 只能改写自己创建的记忆。修正写成新记录
//! 并建立关系，不能覆盖用户原文，也不能原地改掉旧的人格版本。
//!
//! 人格不进入 `memories`。自动写入、范围检索和渐进包在 `memory_access`，
//! 仍必须经过这里的作者门禁。提示词顺序保持为 Host 策略、紧凑人格、L1、L0，
//! 再按阶段加载 L2–L5；本文件不组装完整提示词。

use crate::{Storage, StorageError, StorageResult};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_ID_CHARS: usize = 128;
const MAX_TEXT_CHARS: usize = 2_000;
const MAX_EXCERPT_CHARS: usize = 500;

const MEMORY_COLUMNS: &str = "memory_id, layer, record_kind, content_json, author_kind, mutability, user_id, workspace_id, application_id, task_id, skill_id, created_at_ms, updated_at_ms";
const PERSONALITY_COLUMNS: &str = "personality_id, version, author_kind, mutability, identity, tone, verbosity, language, initiative, behavior_boundary, tool_policy, voice, evolution_note, active, created_at_ms";

/// 调用写入接口的真实身份。
///
/// Agent 工具路径只能传入 [`MemoryActor::Agent`]。存储层不读取模型文本，
/// 也不会把调用者提升成用户或系统。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryActor {
    User,
    Agent,
    System,
}

impl MemoryActor {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::System => "system",
        }
    }
}

/// 记录的创建者。与可变更性成对出现，调用方不能单独指定可变更性。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAuthor {
    User,
    Agent,
    System,
}

impl MemoryAuthor {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::System => "system",
        }
    }

    const fn from_actor(actor: MemoryActor) -> Self {
        match actor {
            MemoryActor::User => Self::User,
            MemoryActor::Agent => Self::Agent,
            MemoryActor::System => Self::System,
        }
    }

    /// 用户记录对 Agent 只读；系统记录只读给系统；Agent 只能改自己的记录。
    pub const fn mutability(self) -> MemoryMutability {
        match self {
            Self::User => MemoryMutability::UserReadonly,
            Self::Agent => MemoryMutability::AgentMutable,
            Self::System => MemoryMutability::SystemReadonly,
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            "system" => Ok(Self::System),
            other => Err(StorageError::InvalidEnum {
                kind: "memory author",
                value: other.to_owned(),
            }),
        }
    }
}

/// 谁可以改写这条记录。必须与作者匹配，不能靠标志位单独放宽。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMutability {
    UserReadonly,
    AgentMutable,
    SystemReadonly,
}

impl MemoryMutability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UserReadonly => "user_readonly",
            Self::AgentMutable => "agent_mutable",
            Self::SystemReadonly => "system_readonly",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "user_readonly" => Ok(Self::UserReadonly),
            "agent_mutable" => Ok(Self::AgentMutable),
            "system_readonly" => Ok(Self::SystemReadonly),
            other => Err(StorageError::InvalidEnum {
                kind: "memory mutability",
                value: other.to_owned(),
            }),
        }
    }
}

/// 记忆层。同一条记录不能同时属于两层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryLayer {
    #[serde(rename = "L0")]
    L0,
    #[serde(rename = "L1")]
    L1,
    #[serde(rename = "L2")]
    L2,
    #[serde(rename = "L3")]
    L3,
    #[serde(rename = "L4")]
    L4,
    #[serde(rename = "L5")]
    L5,
}

impl MemoryLayer {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::L0 => "L0",
            Self::L1 => "L1",
            Self::L2 => "L2",
            Self::L3 => "L3",
            Self::L4 => "L4",
            Self::L5 => "L5",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "L0" => Ok(Self::L0),
            "L1" => Ok(Self::L1),
            "L2" => Ok(Self::L2),
            "L3" => Ok(Self::L3),
            "L4" => Ok(Self::L4),
            "L5" => Ok(Self::L5),
            other => Err(StorageError::InvalidEnum {
                kind: "memory layer",
                value: other.to_owned(),
            }),
        }
    }
}

/// 层内记录种类。种类决定层，调用方不能把种类写进另一个层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRecordKind {
    PiSession,
    RecentTurn,
    CurrentPlan,
    CompactionSummary,
    SafetyRule,
    ToolBoundary,
    ConfirmationPolicy,
    Profile,
    Preference,
    ProjectFact,
    ApplicationHabit,
    TaskSummary,
    Decision,
    VerifiedOutcome,
    MessageEvidence,
    TaskEventEvidence,
    ArtifactEvidence,
    ReceiptEvidence,
    WorkflowCandidate,
    SkillCandidate,
}

impl MemoryRecordKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PiSession => "pi_session",
            Self::RecentTurn => "recent_turn",
            Self::CurrentPlan => "current_plan",
            Self::CompactionSummary => "compaction_summary",
            Self::SafetyRule => "safety_rule",
            Self::ToolBoundary => "tool_boundary",
            Self::ConfirmationPolicy => "confirmation_policy",
            Self::Profile => "profile",
            Self::Preference => "preference",
            Self::ProjectFact => "project_fact",
            Self::ApplicationHabit => "application_habit",
            Self::TaskSummary => "task_summary",
            Self::Decision => "decision",
            Self::VerifiedOutcome => "verified_outcome",
            Self::MessageEvidence => "message_evidence",
            Self::TaskEventEvidence => "task_event_evidence",
            Self::ArtifactEvidence => "artifact_evidence",
            Self::ReceiptEvidence => "receipt_evidence",
            Self::WorkflowCandidate => "workflow_candidate",
            Self::SkillCandidate => "skill_candidate",
        }
    }

    /// 压缩摘要固定在 L0。程序性候选只留在 L5，这里不把它晋升成 Skill。
    pub const fn layer(self) -> MemoryLayer {
        match self {
            Self::PiSession | Self::RecentTurn | Self::CurrentPlan | Self::CompactionSummary => {
                MemoryLayer::L0
            }
            Self::SafetyRule | Self::ToolBoundary | Self::ConfirmationPolicy => MemoryLayer::L1,
            Self::Profile | Self::Preference | Self::ProjectFact | Self::ApplicationHabit => {
                MemoryLayer::L2
            }
            Self::TaskSummary | Self::Decision | Self::VerifiedOutcome => MemoryLayer::L3,
            Self::MessageEvidence
            | Self::TaskEventEvidence
            | Self::ArtifactEvidence
            | Self::ReceiptEvidence => MemoryLayer::L4,
            Self::WorkflowCandidate | Self::SkillCandidate => MemoryLayer::L5,
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "pi_session" => Ok(Self::PiSession),
            "recent_turn" => Ok(Self::RecentTurn),
            "current_plan" => Ok(Self::CurrentPlan),
            "compaction_summary" => Ok(Self::CompactionSummary),
            "safety_rule" => Ok(Self::SafetyRule),
            "tool_boundary" => Ok(Self::ToolBoundary),
            "confirmation_policy" => Ok(Self::ConfirmationPolicy),
            "profile" => Ok(Self::Profile),
            "preference" => Ok(Self::Preference),
            "project_fact" => Ok(Self::ProjectFact),
            "application_habit" => Ok(Self::ApplicationHabit),
            "task_summary" => Ok(Self::TaskSummary),
            "decision" => Ok(Self::Decision),
            "verified_outcome" => Ok(Self::VerifiedOutcome),
            "message_evidence" => Ok(Self::MessageEvidence),
            "task_event_evidence" => Ok(Self::TaskEventEvidence),
            "artifact_evidence" => Ok(Self::ArtifactEvidence),
            "receipt_evidence" => Ok(Self::ReceiptEvidence),
            "workflow_candidate" => Ok(Self::WorkflowCandidate),
            "skill_candidate" => Ok(Self::SkillCandidate),
            other => Err(StorageError::InvalidEnum {
                kind: "memory record kind",
                value: other.to_owned(),
            }),
        }
    }
}

/// 记忆正文。枚举变体本身就是层边界，不能再塞进任意 transcript。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryBody {
    #[serde(rename_all = "camelCase")]
    PiSession {
        runtime_session_ref: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RecentTurn { turn_ref: String, excerpt: String },
    #[serde(rename_all = "camelCase")]
    CurrentPlan {
        objective: String,
        next_step: String,
    },
    #[serde(rename_all = "camelCase")]
    CompactionSummary {
        objective: String,
        constraints: String,
        decisions: String,
        pending: String,
        unknown_outcomes: String,
    },
    #[serde(rename_all = "camelCase")]
    SafetyRule { statement: String },
    #[serde(rename_all = "camelCase")]
    ToolBoundary { statement: String },
    #[serde(rename_all = "camelCase")]
    ConfirmationPolicy { statement: String },
    #[serde(rename_all = "camelCase")]
    Profile { fact: String },
    #[serde(rename_all = "camelCase")]
    Preference { key: String, value: String },
    #[serde(rename_all = "camelCase")]
    ProjectFact { fact: String },
    #[serde(rename_all = "camelCase")]
    ApplicationHabit { application: String, habit: String },
    #[serde(rename_all = "camelCase")]
    TaskSummary { summary: String },
    #[serde(rename_all = "camelCase")]
    Decision { summary: String },
    #[serde(rename_all = "camelCase")]
    VerifiedOutcome { summary: String },
    #[serde(rename_all = "camelCase")]
    MessageEvidence {
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    TaskEventEvidence {
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ArtifactEvidence {
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReceiptEvidence {
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowCandidate { name: String, summary: String },
    #[serde(rename_all = "camelCase")]
    SkillCandidate { name: String, summary: String },
}

impl MemoryBody {
    pub const fn kind(&self) -> MemoryRecordKind {
        match self {
            Self::PiSession { .. } => MemoryRecordKind::PiSession,
            Self::RecentTurn { .. } => MemoryRecordKind::RecentTurn,
            Self::CurrentPlan { .. } => MemoryRecordKind::CurrentPlan,
            Self::CompactionSummary { .. } => MemoryRecordKind::CompactionSummary,
            Self::SafetyRule { .. } => MemoryRecordKind::SafetyRule,
            Self::ToolBoundary { .. } => MemoryRecordKind::ToolBoundary,
            Self::ConfirmationPolicy { .. } => MemoryRecordKind::ConfirmationPolicy,
            Self::Profile { .. } => MemoryRecordKind::Profile,
            Self::Preference { .. } => MemoryRecordKind::Preference,
            Self::ProjectFact { .. } => MemoryRecordKind::ProjectFact,
            Self::ApplicationHabit { .. } => MemoryRecordKind::ApplicationHabit,
            Self::TaskSummary { .. } => MemoryRecordKind::TaskSummary,
            Self::Decision { .. } => MemoryRecordKind::Decision,
            Self::VerifiedOutcome { .. } => MemoryRecordKind::VerifiedOutcome,
            Self::MessageEvidence { .. } => MemoryRecordKind::MessageEvidence,
            Self::TaskEventEvidence { .. } => MemoryRecordKind::TaskEventEvidence,
            Self::ArtifactEvidence { .. } => MemoryRecordKind::ArtifactEvidence,
            Self::ReceiptEvidence { .. } => MemoryRecordKind::ReceiptEvidence,
            Self::WorkflowCandidate { .. } => MemoryRecordKind::WorkflowCandidate,
            Self::SkillCandidate { .. } => MemoryRecordKind::SkillCandidate,
        }
    }
}

/// 检索范围。空范围表示尚未绑定到用户、仓库、应用、任务或 Skill。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub memory_id: String,
    pub layer: MemoryLayer,
    pub record_kind: MemoryRecordKind,
    pub body: MemoryBody,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
    pub scope: MemoryScope,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMemory {
    pub memory_id: String,
    pub body: MemoryBody,
    pub scope: MemoryScope,
    pub sources: Vec<NewMemorySource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceKind {
    Task,
    TaskEvent,
    ConversationTurn,
    Artifact,
    Receipt,
    UserEntry,
    System,
    PiSession,
}

impl MemorySourceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::TaskEvent => "task_event",
            Self::ConversationTurn => "conversation_turn",
            Self::Artifact => "artifact",
            Self::Receipt => "receipt",
            Self::UserEntry => "user_entry",
            Self::System => "system",
            Self::PiSession => "pi_session",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "task" => Ok(Self::Task),
            "task_event" => Ok(Self::TaskEvent),
            "conversation_turn" => Ok(Self::ConversationTurn),
            "artifact" => Ok(Self::Artifact),
            "receipt" => Ok(Self::Receipt),
            "user_entry" => Ok(Self::UserEntry),
            "system" => Ok(Self::System),
            "pi_session" => Ok(Self::PiSession),
            other => Err(StorageError::InvalidEnum {
                kind: "memory source",
                value: other.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMemorySource {
    pub source_id: String,
    pub kind: MemorySourceKind,
    pub source_ref: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    pub source_id: String,
    pub memory_id: String,
    pub kind: MemorySourceKind,
    pub source_ref: String,
    pub note: Option<String>,
    pub created_at_ms: i64,
}

/// 记录之间的显式关系。这不是图数据库，也不能用来覆盖另一条正文。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRelation {
    Supersedes,
    Contradicts,
    Consolidates,
    Associates,
}

impl MemoryRelation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Supersedes => "supersedes",
            Self::Contradicts => "contradicts",
            Self::Consolidates => "consolidates",
            Self::Associates => "associates",
        }
    }

    fn parse(value: &str) -> StorageResult<Self> {
        match value {
            "supersedes" => Ok(Self::Supersedes),
            "contradicts" => Ok(Self::Contradicts),
            "consolidates" => Ok(Self::Consolidates),
            "associates" => Ok(Self::Associates),
            other => Err(StorageError::InvalidEnum {
                kind: "memory relation",
                value: other.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMemoryLink {
    pub link_id: String,
    pub from_memory_id: String,
    pub to_memory_id: String,
    pub relation: MemoryRelation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLink {
    pub link_id: String,
    pub from_memory_id: String,
    pub to_memory_id: String,
    pub relation: MemoryRelation,
    pub created_at_ms: i64,
}

/// 一条记忆及其来源、关系。查询失败必须报错，不能用空列表掩盖缺失记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDetail {
    pub record: MemoryRecord,
    pub sources: Vec<MemorySource>,
    pub links: Vec<MemoryLink>,
}

/// 精确过滤。未设置的字段不参与条件；没有命中时返回空列表。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryQuery {
    pub layer: Option<MemoryLayer>,
    pub record_kind: Option<MemoryRecordKind>,
    pub author: Option<MemoryAuthor>,
    pub user_id: Option<String>,
    pub workspace_id: Option<String>,
    pub application_id: Option<String>,
    pub task_id: Option<String>,
    pub skill_id: Option<String>,
}

/// 改写记忆时只能更换正文和范围。层、种类和作者保持不变。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRevision {
    pub body: MemoryBody,
    pub scope: MemoryScope,
}

/// 人格配置。它描述说话方式，不承载用户事实。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalityDraft {
    pub identity: String,
    pub tone: String,
    pub verbosity: String,
    pub language: String,
    pub initiative: String,
    pub behavior_boundary: String,
    pub tool_policy: String,
    pub voice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evolution_note: Option<String>,
    pub active: bool,
}

/// 一份已落库的人格版本。旧版本保留原文，新版本只追加。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalityRecord {
    pub personality_id: String,
    pub version: i64,
    pub author: MemoryAuthor,
    pub mutability: MemoryMutability,
    pub identity: String,
    pub tone: String,
    pub verbosity: String,
    pub language: String,
    pub initiative: String,
    pub behavior_boundary: String,
    pub tool_policy: String,
    pub voice: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evolution_note: Option<String>,
    pub active: bool,
    pub created_at_ms: i64,
}

struct RawMemory {
    memory_id: String,
    layer: String,
    record_kind: String,
    content_json: String,
    author_kind: String,
    mutability: String,
    user_id: Option<String>,
    workspace_id: Option<String>,
    application_id: Option<String>,
    task_id: Option<String>,
    skill_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl Storage {
    /// 写入一条规范记忆。作者取自 `actor`，可变更性由作者推导，层由正文种类推导。
    pub fn create_memory(
        &mut self,
        actor: MemoryActor,
        draft: &NewMemory,
        now: i64,
    ) -> StorageResult<MemoryRecord> {
        let memory_id = normalize_id(&draft.memory_id, "记忆编号")?;
        let body = normalize_body(&draft.body)?;
        let scope = normalize_scope(&draft.scope)?;
        let sources = normalize_sources(&draft.sources)?;
        require_timestamp(now)?;
        let kind = body.kind();
        let author = MemoryAuthor::from_actor(actor);
        let content = serde_json::to_string(&body)?;
        let transaction = self.connection.transaction()?;
        transaction
            .execute(
                "INSERT INTO memories(
                    memory_id, layer, record_kind, content_json, author_kind, mutability,
                    user_id, workspace_id, application_id, task_id, skill_id,
                    created_at_ms, updated_at_ms
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
                params![
                    memory_id,
                    kind.layer().as_str(),
                    kind.as_str(),
                    content,
                    author.as_str(),
                    author.mutability().as_str(),
                    scope.user_id,
                    scope.workspace_id,
                    scope.application_id,
                    scope.task_id,
                    scope.skill_id,
                    now,
                ],
            )
            .map_err(|err| map_constraint(err, "记忆编号已存在"))?;
        for source in &sources {
            insert_source(&transaction, &memory_id, source, now)?;
        }
        transaction.commit()?;
        self.load_memory(&memory_id)?
            .ok_or_else(|| StorageError::InvalidMemory("写入后读不回记忆".into()))
    }

    pub fn load_memory(&self, memory_id: &str) -> StorageResult<Option<MemoryRecord>> {
        validate_id(memory_id, "记忆编号")?;
        load_memory_on(&self.connection, memory_id)
    }

    /// 改写已有记忆。用户偏好和系统规则拒绝其他作者；种类不能借改写换层。
    pub fn revise_memory(
        &mut self,
        actor: MemoryActor,
        memory_id: &str,
        revision: &MemoryRevision,
        now: i64,
    ) -> StorageResult<MemoryRecord> {
        validate_id(memory_id, "记忆编号")?;
        let body = normalize_body(&revision.body)?;
        let scope = normalize_scope(&revision.scope)?;
        require_timestamp(now)?;
        let content = serde_json::to_string(&body)?;
        let transaction = self.connection.transaction()?;
        let existing = load_memory_on(&transaction, memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        ensure_can_mutate(
            actor,
            existing.author,
            memory_record_class(existing.record_kind),
        )?;
        if body.kind() != existing.record_kind {
            return Err(StorageError::InvalidMemory("记录种类不能改变".into()));
        }
        let changed = transaction.execute(
            "UPDATE memories
             SET content_json = ?2,
                 user_id = ?3, workspace_id = ?4, application_id = ?5, task_id = ?6, skill_id = ?7,
                 updated_at_ms = ?8
             WHERE memory_id = ?1 AND author_kind = ?9 AND record_kind = ?10",
            params![
                memory_id,
                content,
                scope.user_id,
                scope.workspace_id,
                scope.application_id,
                scope.task_id,
                scope.skill_id,
                now,
                existing.author.as_str(),
                existing.record_kind.as_str(),
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::InvalidMemory("记忆在写入前已变化".into()));
        }
        transaction.commit()?;
        self.load_memory(memory_id)?
            .ok_or_else(|| StorageError::InvalidMemory("写入后读不回记忆".into()))
    }

    /// 删除记忆及其来源、关系。Agent 不能借删除清掉用户记录。
    pub fn delete_memory(&mut self, actor: MemoryActor, memory_id: &str) -> StorageResult<()> {
        validate_id(memory_id, "记忆编号")?;
        let transaction = self.connection.transaction()?;
        let existing = load_memory_on(&transaction, memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        ensure_can_mutate(
            actor,
            existing.author,
            memory_record_class(existing.record_kind),
        )?;
        let changed = transaction.execute(
            "DELETE FROM memories WHERE memory_id = ?1 AND author_kind = ?2",
            params![memory_id, existing.author.as_str()],
        )?;
        if changed != 1 {
            return Err(StorageError::InvalidMemory("记忆在删除前已变化".into()));
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_memories(&self, query: &MemoryQuery) -> StorageResult<Vec<MemoryRecord>> {
        validate_query(query)?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories
                 WHERE (?1 IS NULL OR layer = ?1)
                   AND (?2 IS NULL OR record_kind = ?2)
                   AND (?3 IS NULL OR author_kind = ?3)
                   AND (?4 IS NULL OR user_id = ?4)
                   AND (?5 IS NULL OR workspace_id = ?5)
                   AND (?6 IS NULL OR application_id = ?6)
                   AND (?7 IS NULL OR task_id = ?7)
                   AND (?8 IS NULL OR skill_id = ?8)
                 ORDER BY layer ASC, created_at_ms ASC, memory_id ASC"
        ))?;
        let rows = statement.query_map(
            params![
                query.layer.map(MemoryLayer::as_str),
                query.record_kind.map(MemoryRecordKind::as_str),
                query.author.map(MemoryAuthor::as_str),
                query.user_id.as_deref(),
                query.workspace_id.as_deref(),
                query.application_id.as_deref(),
                query.task_id.as_deref(),
                query.skill_id.as_deref(),
            ],
            raw_memory_from_row,
        )?;
        let mut records = Vec::new();
        for row in rows {
            records.push(decode_memory(row?)?);
        }
        Ok(records)
    }

    /// 读取正文、来源和关系。记忆不存在时返回错误，而不是空来源列表。
    pub fn memory_detail(&self, memory_id: &str) -> StorageResult<MemoryDetail> {
        let record = self
            .load_memory(memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        Ok(MemoryDetail {
            sources: self.list_memory_sources(memory_id)?,
            links: self.list_memory_links(memory_id)?,
            record,
        })
    }

    /// 追加来源。来源会改变记录的证据，因此沿用正文的作者限制。
    pub fn attach_memory_source(
        &mut self,
        actor: MemoryActor,
        memory_id: &str,
        source: &NewMemorySource,
        now: i64,
    ) -> StorageResult<MemorySource> {
        validate_id(memory_id, "记忆编号")?;
        let source = normalize_source(source)?;
        require_timestamp(now)?;
        let transaction = self.connection.transaction()?;
        let existing = load_memory_on(&transaction, memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        ensure_can_mutate(
            actor,
            existing.author,
            memory_record_class(existing.record_kind),
        )?;
        insert_source(&transaction, memory_id, &source, now)?;
        transaction.commit()?;
        self.load_source(&source.source_id)
    }

    pub fn list_memory_sources(&self, memory_id: &str) -> StorageResult<Vec<MemorySource>> {
        self.require_memory(memory_id)?;
        let mut statement = self.connection.prepare(
            "SELECT source_id, memory_id, source_kind, source_ref, note, created_at_ms
             FROM memory_sources WHERE memory_id = ?1
             ORDER BY created_at_ms ASC, source_id ASC",
        )?;
        let rows = statement.query_map([memory_id], source_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 建立关系。只新增关系行，不更新两端正文。
    ///
    /// 起点必须是调用者可以改写的记录。这样 Agent 可以用自己的新记录指向用户记录，
    /// 但不能从用户记录向外声明 supersedes。
    pub fn link_memories(
        &mut self,
        actor: MemoryActor,
        link: &NewMemoryLink,
        now: i64,
    ) -> StorageResult<MemoryLink> {
        let link_id = normalize_id(&link.link_id, "关系编号")?;
        let from_memory_id = normalize_id(&link.from_memory_id, "关系起点")?;
        let to_memory_id = normalize_id(&link.to_memory_id, "关系终点")?;
        require_timestamp(now)?;
        if from_memory_id == to_memory_id {
            return Err(StorageError::InvalidMemory("记忆不能关联到自己".into()));
        }
        let transaction = self.connection.transaction()?;
        let from = load_memory_on(&transaction, &from_memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(from_memory_id.clone()))?;
        if load_memory_on(&transaction, &to_memory_id)?.is_none() {
            return Err(StorageError::MemoryNotFound(to_memory_id));
        }
        ensure_can_mutate(actor, from.author, memory_record_class(from.record_kind))?;
        transaction
            .execute(
                "INSERT INTO memory_links(
                    link_id, from_memory_id, to_memory_id, relation, created_at_ms
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    link_id,
                    from_memory_id,
                    to_memory_id,
                    link.relation.as_str(),
                    now,
                ],
            )
            .map_err(|err| map_constraint(err, "同一关系已存在"))?;
        transaction.commit()?;
        self.load_link(&link_id)
    }

    /// 创建人格。Agent 不能创建，避免模型推断被写成用户人格。
    pub fn create_personality(
        &mut self,
        actor: MemoryActor,
        personality_id: &str,
        draft: &PersonalityDraft,
        now: i64,
    ) -> StorageResult<PersonalityRecord> {
        if matches!(actor, MemoryActor::Agent) {
            return Err(StorageError::OwnershipDenied {
                actor: "agent",
                record_class: "人格",
                author: "agent",
            });
        }
        let personality_id = normalize_id(personality_id, "人格编号")?;
        let draft = normalize_personality(draft)?;
        require_timestamp(now)?;
        let author = MemoryAuthor::from_actor(actor);
        let transaction = self.connection.transaction()?;
        if load_personality_on(&transaction, &personality_id)?.is_some() {
            return Err(StorageError::InvalidMemory("人格记录已存在".into()));
        }
        insert_personality(&transaction, &personality_id, 1, author, &draft, now)?;
        transaction.commit()?;
        self.load_personality(&personality_id)?
            .ok_or_else(|| StorageError::InvalidMemory("写入后读不回人格".into()))
    }

    /// 追加人格新版本。历史版本保留原文，Agent 对用户版本直接拒绝。
    pub fn revise_personality(
        &mut self,
        actor: MemoryActor,
        personality_id: &str,
        draft: &PersonalityDraft,
        now: i64,
    ) -> StorageResult<PersonalityRecord> {
        let personality_id = normalize_id(personality_id, "人格编号")?;
        let draft = normalize_personality(draft)?;
        require_timestamp(now)?;
        let transaction = self.connection.transaction()?;
        let existing = load_personality_on(&transaction, &personality_id)?
            .ok_or_else(|| StorageError::PersonalityNotFound(personality_id.clone()))?;
        ensure_personality_actor(actor, existing.author)?;
        insert_personality(
            &transaction,
            &personality_id,
            existing.version + 1,
            existing.author,
            &draft,
            now,
        )?;
        transaction.commit()?;
        self.load_personality(&personality_id)?
            .ok_or_else(|| StorageError::InvalidMemory("写入后读不回人格".into()))
    }

    pub fn delete_personality(
        &mut self,
        actor: MemoryActor,
        personality_id: &str,
    ) -> StorageResult<()> {
        validate_id(personality_id, "人格编号")?;
        let transaction = self.connection.transaction()?;
        let existing = load_personality_on(&transaction, personality_id)?
            .ok_or_else(|| StorageError::PersonalityNotFound(personality_id.to_owned()))?;
        ensure_personality_actor(actor, existing.author)?;
        let changed = transaction.execute(
            "DELETE FROM personality_records WHERE personality_id = ?1 AND author_kind = ?2",
            params![personality_id, existing.author.as_str()],
        )?;
        if changed == 0 {
            return Err(StorageError::InvalidMemory("人格记录在删除前已变化".into()));
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn load_personality(
        &self,
        personality_id: &str,
    ) -> StorageResult<Option<PersonalityRecord>> {
        validate_id(personality_id, "人格编号")?;
        load_personality_on(&self.connection, personality_id)
    }

    pub fn list_personalities(&self) -> StorageResult<Vec<PersonalityRecord>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {PERSONALITY_COLUMNS} FROM personality_records AS current
             WHERE version = (
                 SELECT MAX(version) FROM personality_records
                 WHERE personality_id = current.personality_id
             )
             ORDER BY personality_id ASC"
        ))?;
        let rows = statement.query_map([], raw_personality_from_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(decode_personality(row?)?);
        }
        Ok(records)
    }

    /// 按版本返回人格。记录不存在时是错误，不能用空列表表示缺失。
    pub fn list_personality_versions(
        &self,
        personality_id: &str,
    ) -> StorageResult<Vec<PersonalityRecord>> {
        validate_id(personality_id, "人格编号")?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {PERSONALITY_COLUMNS} FROM personality_records
             WHERE personality_id = ?1 ORDER BY version ASC"
        ))?;
        let rows = statement.query_map([personality_id], raw_personality_from_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(decode_personality(row?)?);
        }
        if records.is_empty() {
            return Err(StorageError::PersonalityNotFound(personality_id.to_owned()));
        }
        Ok(records)
    }

    pub fn list_memory_links(&self, memory_id: &str) -> StorageResult<Vec<MemoryLink>> {
        self.require_memory(memory_id)?;
        let mut statement = self.connection.prepare(
            "SELECT link_id, from_memory_id, to_memory_id, relation, created_at_ms
             FROM memory_links
             WHERE from_memory_id = ?1 OR to_memory_id = ?1
             ORDER BY created_at_ms ASC, link_id ASC",
        )?;
        let rows = statement.query_map([memory_id], |row| {
            Ok(MemoryLink {
                link_id: row.get(0)?,
                from_memory_id: row.get(1)?,
                to_memory_id: row.get(2)?,
                relation: MemoryRelation::parse(&row.get::<_, String>(3)?)
                    .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?,
                created_at_ms: row.get(4)?,
            })
        })?;
        let mut links = Vec::new();
        for row in rows {
            links.push(row.map_err(decode_row_error)?);
        }
        Ok(links)
    }

    fn require_memory(&self, memory_id: &str) -> StorageResult<MemoryRecord> {
        self.load_memory(memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))
    }

    fn load_source(&self, source_id: &str) -> StorageResult<MemorySource> {
        self.connection
            .query_row(
                "SELECT source_id, memory_id, source_kind, source_ref, note, created_at_ms
                 FROM memory_sources WHERE source_id = ?1",
                [source_id],
                source_from_row,
            )
            .optional()?
            .ok_or_else(|| StorageError::InvalidMemory("写入后读不回来源".into()))
    }

    fn load_link(&self, link_id: &str) -> StorageResult<MemoryLink> {
        let raw = self
            .connection
            .query_row(
                "SELECT link_id, from_memory_id, to_memory_id, relation, created_at_ms
                 FROM memory_links WHERE link_id = ?1",
                [link_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((link_id, from_memory_id, to_memory_id, relation, created_at_ms)) = raw else {
            return Err(StorageError::InvalidMemory("写入后读不回关系".into()));
        };
        Ok(MemoryLink {
            link_id,
            from_memory_id,
            to_memory_id,
            relation: MemoryRelation::parse(&relation)?,
            created_at_ms,
        })
    }
}

fn load_memory_on(
    connection: &rusqlite::Connection,
    memory_id: &str,
) -> StorageResult<Option<MemoryRecord>> {
    let raw = connection
        .query_row(
            &format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE memory_id = ?1"),
            [memory_id],
            raw_memory_from_row,
        )
        .optional()?;
    raw.map(decode_memory).transpose()
}

pub(crate) fn check_memory_id(value: &str, field: &str) -> StorageResult<()> {
    validate_id(value, field)
}

pub(crate) fn actor_may_mutate(actor: MemoryActor, author: MemoryAuthor) -> bool {
    ensure_can_mutate(actor, author, "记忆").is_ok()
}

/// 只有与作者相同的调用者可以改写。系统身份不能代替用户，Agent 也不能。
fn ensure_can_mutate(
    actor: MemoryActor,
    author: MemoryAuthor,
    record_class: &'static str,
) -> StorageResult<()> {
    let allowed = matches!(
        (actor, author),
        (MemoryActor::User, MemoryAuthor::User)
            | (MemoryActor::Agent, MemoryAuthor::Agent)
            | (MemoryActor::System, MemoryAuthor::System)
    );
    if allowed {
        Ok(())
    } else {
        Err(StorageError::OwnershipDenied {
            actor: actor.as_str(),
            record_class,
            author: author.as_str(),
        })
    }
}

fn memory_record_class(kind: MemoryRecordKind) -> &'static str {
    if kind == MemoryRecordKind::Preference {
        "偏好"
    } else {
        "记忆"
    }
}

/// 人格没有 Agent 可写路径。即使用户记录被误标成 Agent，写入仍要拒绝。
fn ensure_personality_actor(actor: MemoryActor, author: MemoryAuthor) -> StorageResult<()> {
    if matches!(actor, MemoryActor::Agent) {
        return Err(StorageError::OwnershipDenied {
            actor: actor.as_str(),
            record_class: "人格",
            author: author.as_str(),
        });
    }
    ensure_can_mutate(actor, author, "人格")
}

fn insert_source(
    connection: &rusqlite::Connection,
    memory_id: &str,
    source: &NewMemorySource,
    now: i64,
) -> StorageResult<()> {
    connection
        .execute(
            "INSERT INTO memory_sources(
                source_id, memory_id, source_kind, source_ref, note, created_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                source.source_id,
                memory_id,
                source.kind.as_str(),
                source.source_ref,
                source.note,
                now,
            ],
        )
        .map_err(|err| map_constraint(err, "记忆来源已存在"))?;
    Ok(())
}

fn source_from_row(row: &Row<'_>) -> rusqlite::Result<MemorySource> {
    let kind: String = row.get(2)?;
    Ok(MemorySource {
        source_id: row.get(0)?,
        memory_id: row.get(1)?,
        kind: MemorySourceKind::parse(&kind)
            .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?,
        source_ref: row.get(3)?,
        note: row.get(4)?,
        created_at_ms: row.get(5)?,
    })
}

fn raw_memory_from_row(row: &Row<'_>) -> rusqlite::Result<RawMemory> {
    Ok(RawMemory {
        memory_id: row.get(0)?,
        layer: row.get(1)?,
        record_kind: row.get(2)?,
        content_json: row.get(3)?,
        author_kind: row.get(4)?,
        mutability: row.get(5)?,
        user_id: row.get(6)?,
        workspace_id: row.get(7)?,
        application_id: row.get(8)?,
        task_id: row.get(9)?,
        skill_id: row.get(10)?,
        created_at_ms: row.get(11)?,
        updated_at_ms: row.get(12)?,
    })
}

/// 损坏行必须失败。层、种类、正文和可变更性不一致时不能静默跳过。
fn decode_memory(raw: RawMemory) -> StorageResult<MemoryRecord> {
    let layer = MemoryLayer::parse(&raw.layer)?;
    let record_kind = MemoryRecordKind::parse(&raw.record_kind)?;
    let author = MemoryAuthor::parse(&raw.author_kind)?;
    let mutability = MemoryMutability::parse(&raw.mutability)?;
    if record_kind.layer() != layer {
        return Err(StorageError::InvalidMemory("记忆层与记录种类不一致".into()));
    }
    if author.mutability() != mutability {
        return Err(StorageError::InvalidMemory(
            "记忆作者与可变更性不一致".into(),
        ));
    }
    let body: MemoryBody = serde_json::from_str(&raw.content_json)
        .map_err(|_| StorageError::InvalidMemory("记忆正文无法按记录种类解码".into()))?;
    if body.kind() != record_kind {
        return Err(StorageError::InvalidMemory(
            "记忆正文种类与记录种类不一致".into(),
        ));
    }
    Ok(MemoryRecord {
        memory_id: raw.memory_id,
        layer,
        record_kind,
        body,
        author,
        mutability,
        scope: MemoryScope {
            user_id: raw.user_id,
            workspace_id: raw.workspace_id,
            application_id: raw.application_id,
            task_id: raw.task_id,
            skill_id: raw.skill_id,
        },
        created_at_ms: raw.created_at_ms,
        updated_at_ms: raw.updated_at_ms,
    })
}

fn decode_row_error(err: rusqlite::Error) -> StorageError {
    match err {
        rusqlite::Error::ToSqlConversionFailure(source) => source
            .downcast::<StorageError>()
            .map(|boxed| *boxed)
            .unwrap_or_else(|source| StorageError::InvalidMemory(source.to_string())),
        other => StorageError::from(other),
    }
}

fn map_constraint(err: rusqlite::Error, duplicate: &str) -> StorageError {
    match err {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            // 2067 UNIQUE，1555 PRIMARY KEY，787 FOREIGN KEY。其余 CHECK 保持稳定语义。
            match code.extended_code {
                2067 | 1555 => StorageError::InvalidMemory(duplicate.to_owned()),
                787 => StorageError::InvalidMemory("关联的记忆不存在".into()),
                _ => StorageError::InvalidMemory("记忆记录违反 Schema 约束".into()),
            }
        }
        other => StorageError::from(other),
    }
}

fn require_timestamp(now: i64) -> StorageResult<()> {
    if now < 0 {
        return Err(StorageError::InvalidMemory("时间不能为负".into()));
    }
    Ok(())
}

fn validate_id(value: &str, field: &str) -> StorageResult<()> {
    if value.is_empty()
        || value.chars().count() > MAX_ID_CHARS
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(StorageError::InvalidMemory(format!("{field}无效")));
    }
    Ok(())
}

fn normalize_id(value: &str, field: &str) -> StorageResult<String> {
    validate_id(value, field)?;
    Ok(value.to_owned())
}

fn clean_text(value: &str, field: &str, max_chars: usize) -> StorageResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) || value.chars().count() > max_chars
    {
        return Err(StorageError::InvalidMemory(format!("{field}无效")));
    }
    Ok(value.to_owned())
}

fn clean_optional(
    value: &Option<String>,
    field: &str,
    max_chars: usize,
) -> StorageResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => Ok(Some(clean_text(text, field, max_chars)?)),
    }
}

fn normalize_scope(scope: &MemoryScope) -> StorageResult<MemoryScope> {
    Ok(MemoryScope {
        user_id: normalize_optional_id(scope.user_id.as_deref(), "用户范围")?,
        workspace_id: normalize_optional_id(scope.workspace_id.as_deref(), "工作区范围")?,
        application_id: normalize_optional_id(scope.application_id.as_deref(), "应用范围")?,
        task_id: normalize_optional_id(scope.task_id.as_deref(), "任务范围")?,
        skill_id: normalize_optional_id(scope.skill_id.as_deref(), "Skill 范围")?,
    })
}

fn normalize_optional_id(value: Option<&str>, field: &str) -> StorageResult<Option<String>> {
    value.map(|id| normalize_id(id, field)).transpose()
}

fn validate_query(query: &MemoryQuery) -> StorageResult<()> {
    for (value, field) in [
        (query.user_id.as_deref(), "用户范围"),
        (query.workspace_id.as_deref(), "工作区范围"),
        (query.application_id.as_deref(), "应用范围"),
        (query.task_id.as_deref(), "任务范围"),
        (query.skill_id.as_deref(), "Skill 范围"),
    ] {
        if let Some(value) = value {
            validate_id(value, field)?;
        }
    }
    Ok(())
}

fn normalize_sources(sources: &[NewMemorySource]) -> StorageResult<Vec<NewMemorySource>> {
    let mut seen_ids = HashSet::new();
    let mut seen_refs = HashSet::new();
    let mut normalized = Vec::with_capacity(sources.len());
    for source in sources {
        let source = normalize_source(source)?;
        if !seen_ids.insert(source.source_id.clone())
            || !seen_refs.insert((source.kind, source.source_ref.clone()))
        {
            return Err(StorageError::InvalidMemory("记忆来源重复".into()));
        }
        normalized.push(source);
    }
    Ok(normalized)
}

fn normalize_source(source: &NewMemorySource) -> StorageResult<NewMemorySource> {
    Ok(NewMemorySource {
        source_id: normalize_id(&source.source_id, "来源编号")?,
        kind: source.kind,
        source_ref: clean_text(&source.source_ref, "来源引用", MAX_TEXT_CHARS)?,
        note: clean_optional(&source.note, "来源摘录", MAX_EXCERPT_CHARS)?,
    })
}

struct RawPersonality {
    personality_id: String,
    version: i64,
    author_kind: String,
    mutability: String,
    identity: String,
    tone: String,
    verbosity: String,
    language: String,
    initiative: String,
    behavior_boundary: String,
    tool_policy: String,
    voice: String,
    evolution_note: Option<String>,
    active: i64,
    created_at_ms: i64,
}

fn load_personality_on(
    connection: &rusqlite::Connection,
    personality_id: &str,
) -> StorageResult<Option<PersonalityRecord>> {
    let raw = connection
        .query_row(
            &format!(
                "SELECT {PERSONALITY_COLUMNS} FROM personality_records
                 WHERE personality_id = ?1 ORDER BY version DESC LIMIT 1"
            ),
            [personality_id],
            raw_personality_from_row,
        )
        .optional()?;
    raw.map(decode_personality).transpose()
}

fn insert_personality(
    connection: &rusqlite::Connection,
    personality_id: &str,
    version: i64,
    author: MemoryAuthor,
    draft: &PersonalityDraft,
    now: i64,
) -> StorageResult<()> {
    if draft.active {
        connection.execute(
            "UPDATE personality_records SET active = 0 WHERE active = 1",
            [],
        )?;
    }
    connection
        .execute(
            "INSERT INTO personality_records(
                personality_id, version, author_kind, mutability,
                identity, tone, verbosity, language, initiative,
                behavior_boundary, tool_policy, voice, evolution_note,
                active, created_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                personality_id,
                version,
                author.as_str(),
                author.mutability().as_str(),
                draft.identity,
                draft.tone,
                draft.verbosity,
                draft.language,
                draft.initiative,
                draft.behavior_boundary,
                draft.tool_policy,
                draft.voice,
                draft.evolution_note,
                i64::from(draft.active),
                now,
            ],
        )
        .map_err(|err| map_constraint(err, "人格版本已存在"))?;
    Ok(())
}

fn raw_personality_from_row(row: &Row<'_>) -> rusqlite::Result<RawPersonality> {
    Ok(RawPersonality {
        personality_id: row.get(0)?,
        version: row.get(1)?,
        author_kind: row.get(2)?,
        mutability: row.get(3)?,
        identity: row.get(4)?,
        tone: row.get(5)?,
        verbosity: row.get(6)?,
        language: row.get(7)?,
        initiative: row.get(8)?,
        behavior_boundary: row.get(9)?,
        tool_policy: row.get(10)?,
        voice: row.get(11)?,
        evolution_note: row.get(12)?,
        active: row.get(13)?,
        created_at_ms: row.get(14)?,
    })
}

fn decode_personality(raw: RawPersonality) -> StorageResult<PersonalityRecord> {
    let author = MemoryAuthor::parse(&raw.author_kind)?;
    let mutability = MemoryMutability::parse(&raw.mutability)?;
    if matches!(author, MemoryAuthor::Agent) || author.mutability() != mutability {
        return Err(StorageError::InvalidMemory(
            "人格作者与可变更性不一致".into(),
        ));
    }
    let active = match raw.active {
        0 => false,
        1 => true,
        _ => {
            return Err(StorageError::InvalidMemory("人格启用标记无效".into()));
        }
    };
    Ok(PersonalityRecord {
        personality_id: raw.personality_id,
        version: raw.version,
        author,
        mutability,
        identity: raw.identity,
        tone: raw.tone,
        verbosity: raw.verbosity,
        language: raw.language,
        initiative: raw.initiative,
        behavior_boundary: raw.behavior_boundary,
        tool_policy: raw.tool_policy,
        voice: raw.voice,
        evolution_note: raw.evolution_note,
        active,
        created_at_ms: raw.created_at_ms,
    })
}

fn normalize_personality(draft: &PersonalityDraft) -> StorageResult<PersonalityDraft> {
    Ok(PersonalityDraft {
        identity: clean_text(&draft.identity, "人格身份", MAX_TEXT_CHARS)?,
        tone: clean_text(&draft.tone, "语气", MAX_TEXT_CHARS)?,
        verbosity: clean_text(&draft.verbosity, "详略", MAX_TEXT_CHARS)?,
        language: clean_text(&draft.language, "语言", MAX_TEXT_CHARS)?,
        initiative: clean_text(&draft.initiative, "主动程度", MAX_TEXT_CHARS)?,
        behavior_boundary: clean_text(&draft.behavior_boundary, "行为边界", MAX_TEXT_CHARS)?,
        tool_policy: clean_text(&draft.tool_policy, "工具偏好", MAX_TEXT_CHARS)?,
        voice: clean_text(&draft.voice, "语音偏好", MAX_TEXT_CHARS)?,
        evolution_note: clean_optional(&draft.evolution_note, "演化备注", MAX_TEXT_CHARS)?,
        active: draft.active,
    })
}

fn normalize_body(body: &MemoryBody) -> StorageResult<MemoryBody> {
    Ok(match body {
        MemoryBody::PiSession {
            runtime_session_ref,
            note,
        } => MemoryBody::PiSession {
            runtime_session_ref: normalize_id(runtime_session_ref, "Pi 会话引用")?,
            note: clean_optional(note, "会话备注", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::RecentTurn { turn_ref, excerpt } => MemoryBody::RecentTurn {
            turn_ref: normalize_id(turn_ref, "回合引用")?,
            excerpt: clean_text(excerpt, "工作摘录", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::CurrentPlan {
            objective,
            next_step,
        } => MemoryBody::CurrentPlan {
            objective: clean_text(objective, "当前目标", MAX_TEXT_CHARS)?,
            next_step: clean_text(next_step, "下一步", MAX_TEXT_CHARS)?,
        },
        MemoryBody::CompactionSummary {
            objective,
            constraints,
            decisions,
            pending,
            unknown_outcomes,
        } => MemoryBody::CompactionSummary {
            objective: clean_text(objective, "压缩目标", MAX_TEXT_CHARS)?,
            constraints: clean_text(constraints, "压缩约束", MAX_TEXT_CHARS)?,
            decisions: clean_text(decisions, "压缩决定", MAX_TEXT_CHARS)?,
            pending: clean_text(pending, "压缩待办", MAX_TEXT_CHARS)?,
            unknown_outcomes: clean_text(unknown_outcomes, "未核对结果", MAX_TEXT_CHARS)?,
        },
        MemoryBody::SafetyRule { statement } => MemoryBody::SafetyRule {
            statement: clean_text(statement, "安全规则", MAX_TEXT_CHARS)?,
        },
        MemoryBody::ToolBoundary { statement } => MemoryBody::ToolBoundary {
            statement: clean_text(statement, "工具边界", MAX_TEXT_CHARS)?,
        },
        MemoryBody::ConfirmationPolicy { statement } => MemoryBody::ConfirmationPolicy {
            statement: clean_text(statement, "确认策略", MAX_TEXT_CHARS)?,
        },
        MemoryBody::Profile { fact } => MemoryBody::Profile {
            fact: clean_text(fact, "档案事实", MAX_TEXT_CHARS)?,
        },
        MemoryBody::Preference { key, value } => MemoryBody::Preference {
            key: clean_text(key, "偏好键", MAX_TEXT_CHARS)?,
            value: clean_text(value, "偏好值", MAX_TEXT_CHARS)?,
        },
        MemoryBody::ProjectFact { fact } => MemoryBody::ProjectFact {
            fact: clean_text(fact, "项目事实", MAX_TEXT_CHARS)?,
        },
        MemoryBody::ApplicationHabit { application, habit } => MemoryBody::ApplicationHabit {
            application: clean_text(application, "应用", MAX_TEXT_CHARS)?,
            habit: clean_text(habit, "使用习惯", MAX_TEXT_CHARS)?,
        },
        MemoryBody::TaskSummary { summary } => MemoryBody::TaskSummary {
            summary: clean_text(summary, "情节摘要", MAX_TEXT_CHARS)?,
        },
        MemoryBody::Decision { summary } => MemoryBody::Decision {
            summary: clean_text(summary, "决定摘要", MAX_TEXT_CHARS)?,
        },
        MemoryBody::VerifiedOutcome { summary } => MemoryBody::VerifiedOutcome {
            summary: clean_text(summary, "已验证结果", MAX_TEXT_CHARS)?,
        },
        MemoryBody::MessageEvidence { reference, note } => MemoryBody::MessageEvidence {
            reference: clean_text(reference, "消息证据", MAX_TEXT_CHARS)?,
            note: clean_optional(note, "证据备注", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::TaskEventEvidence { reference, note } => MemoryBody::TaskEventEvidence {
            reference: clean_text(reference, "任务事件证据", MAX_TEXT_CHARS)?,
            note: clean_optional(note, "证据备注", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::ArtifactEvidence { reference, note } => MemoryBody::ArtifactEvidence {
            reference: clean_text(reference, "产物证据", MAX_TEXT_CHARS)?,
            note: clean_optional(note, "证据备注", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::ReceiptEvidence { reference, note } => MemoryBody::ReceiptEvidence {
            reference: clean_text(reference, "回执证据", MAX_TEXT_CHARS)?,
            note: clean_optional(note, "证据备注", MAX_EXCERPT_CHARS)?,
        },
        MemoryBody::WorkflowCandidate { name, summary } => MemoryBody::WorkflowCandidate {
            name: clean_text(name, "流程候选名", MAX_TEXT_CHARS)?,
            summary: clean_text(summary, "流程候选摘要", MAX_TEXT_CHARS)?,
        },
        MemoryBody::SkillCandidate { name, summary } => MemoryBody::SkillCandidate {
            name: clean_text(name, "Skill 候选名", MAX_TEXT_CHARS)?,
            summary: clean_text(summary, "Skill 候选摘要", MAX_TEXT_CHARS)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Storage {
        Storage::open_in_memory().expect("memory database should open")
    }

    fn body_for(kind: MemoryRecordKind) -> MemoryBody {
        match kind {
            MemoryRecordKind::PiSession => MemoryBody::PiSession {
                runtime_session_ref: "pi_session_1".into(),
                note: Some("当前会话".into()),
            },
            MemoryRecordKind::RecentTurn => MemoryBody::RecentTurn {
                turn_ref: "turn_1".into(),
                excerpt: "只保留这一句工作摘录".into(),
            },
            MemoryRecordKind::CurrentPlan => MemoryBody::CurrentPlan {
                objective: "完成记忆 Schema".into(),
                next_step: "核对层级".into(),
            },
            MemoryRecordKind::CompactionSummary => MemoryBody::CompactionSummary {
                objective: "记住当前目标".into(),
                constraints: "不把摘要晋升为长期记忆".into(),
                decisions: "压缩只属于 L0".into(),
                pending: "继续当前任务".into(),
                unknown_outcomes: "没有未核对副作用".into(),
            },
            MemoryRecordKind::SafetyRule => MemoryBody::SafetyRule {
                statement: "外部副作用默认需要确认".into(),
            },
            MemoryRecordKind::ToolBoundary => MemoryBody::ToolBoundary {
                statement: "不暴露任意脚本".into(),
            },
            MemoryRecordKind::ConfirmationPolicy => MemoryBody::ConfirmationPolicy {
                statement: "读操作默认可自动执行".into(),
            },
            MemoryRecordKind::Profile => MemoryBody::Profile {
                fact: "用户使用简体中文".into(),
            },
            MemoryRecordKind::Preference => MemoryBody::Preference {
                key: "reply.language".into(),
                value: "zh-CN".into(),
            },
            MemoryRecordKind::ProjectFact => MemoryBody::ProjectFact {
                fact: "Semi-OS 的持久化由 Rust 持有".into(),
            },
            MemoryRecordKind::ApplicationHabit => MemoryBody::ApplicationHabit {
                application: "TextEdit".into(),
                habit: "先观察再输入".into(),
            },
            MemoryRecordKind::TaskSummary => MemoryBody::TaskSummary {
                summary: "上次任务核对了桌面动作".into(),
            },
            MemoryRecordKind::Decision => MemoryBody::Decision {
                summary: "不确定结果先对账".into(),
            },
            MemoryRecordKind::VerifiedOutcome => MemoryBody::VerifiedOutcome {
                summary: "回执已验证".into(),
            },
            MemoryRecordKind::MessageEvidence => MemoryBody::MessageEvidence {
                reference: "conversation_turn:turn_1".into(),
                note: Some("指向原消息".into()),
            },
            MemoryRecordKind::TaskEventEvidence => MemoryBody::TaskEventEvidence {
                reference: "task_event:event_1".into(),
                note: None,
            },
            MemoryRecordKind::ArtifactEvidence => MemoryBody::ArtifactEvidence {
                reference: "artifact:artifact_1".into(),
                note: None,
            },
            MemoryRecordKind::ReceiptEvidence => MemoryBody::ReceiptEvidence {
                reference: "receipt:receipt_1".into(),
                note: None,
            },
            MemoryRecordKind::WorkflowCandidate => MemoryBody::WorkflowCandidate {
                name: "观察后输入".into(),
                summary: "可重复的桌面步骤候选".into(),
            },
            MemoryRecordKind::SkillCandidate => MemoryBody::SkillCandidate {
                name: "desktop-observe-type".into(),
                summary: "只是候选，不自动晋升为受信任 Skill".into(),
            },
        }
    }

    fn all_kinds() -> Vec<MemoryRecordKind> {
        let kinds = vec![
            MemoryRecordKind::PiSession,
            MemoryRecordKind::RecentTurn,
            MemoryRecordKind::CurrentPlan,
            MemoryRecordKind::CompactionSummary,
            MemoryRecordKind::SafetyRule,
            MemoryRecordKind::ToolBoundary,
            MemoryRecordKind::ConfirmationPolicy,
            MemoryRecordKind::Profile,
            MemoryRecordKind::Preference,
            MemoryRecordKind::ProjectFact,
            MemoryRecordKind::ApplicationHabit,
            MemoryRecordKind::TaskSummary,
            MemoryRecordKind::Decision,
            MemoryRecordKind::VerifiedOutcome,
            MemoryRecordKind::MessageEvidence,
            MemoryRecordKind::TaskEventEvidence,
            MemoryRecordKind::ArtifactEvidence,
            MemoryRecordKind::ReceiptEvidence,
            MemoryRecordKind::WorkflowCandidate,
            MemoryRecordKind::SkillCandidate,
        ];
        assert!(
            kinds.iter().all(|kind| body_for(*kind).kind() == *kind),
            "sample body drifted from its kind"
        );
        kinds
    }

    fn create_kind(db: &mut Storage, kind: MemoryRecordKind, actor: MemoryActor) -> MemoryRecord {
        db.create_memory(
            actor,
            &NewMemory {
                memory_id: format!("mem_{}", kind.as_str()),
                body: body_for(kind),
                scope: MemoryScope {
                    user_id: Some("user_1".into()),
                    task_id: Some("task_1".into()),
                    ..MemoryScope::default()
                },
                sources: Vec::new(),
            },
            10,
        )
        .expect("memory should be stored")
    }

    #[test]
    fn each_kind_stays_on_its_own_layer() {
        let mut db = open();
        assert!(db.schema_version().unwrap() >= 13);
        let mut counts = [0; 6];
        for kind in all_kinds() {
            let actor = if kind.layer() == MemoryLayer::L1 {
                MemoryActor::System
            } else if kind == MemoryRecordKind::Preference {
                MemoryActor::User
            } else {
                MemoryActor::Agent
            };
            let stored = create_kind(&mut db, kind, actor);
            assert_eq!(stored.layer, kind.layer());
            assert_eq!(stored.record_kind, kind);
            assert_eq!(stored.body.kind(), kind);
            counts[layer_index(kind.layer())] += 1;
            let listed = db
                .list_memories(&MemoryQuery {
                    layer: Some(kind.layer()),
                    record_kind: Some(kind),
                    ..MemoryQuery::default()
                })
                .unwrap();
            assert!(listed
                .iter()
                .any(|record| record.memory_id == stored.memory_id));
            assert!(listed.iter().all(|record| record.layer == kind.layer()));
        }
        assert_eq!(counts, [4, 3, 4, 3, 4, 2]);
        let compaction = db.load_memory("mem_compaction_summary").unwrap().unwrap();
        assert_eq!(compaction.layer, MemoryLayer::L0);
        assert!(db
            .list_memories(&MemoryQuery {
                layer: Some(MemoryLayer::L3),
                ..MemoryQuery::default()
            })
            .unwrap()
            .iter()
            .all(|record| record.record_kind != MemoryRecordKind::CompactionSummary));
        let json = serde_json::to_value(&compaction).unwrap();
        assert_eq!(json["layer"], "L0");
        assert_eq!(json["recordKind"], "compaction_summary");
        assert_eq!(json["body"]["kind"], "compaction_summary");
    }

    #[test]
    fn sources_and_links_stay_queryable_without_rewriting_either_body() {
        let mut db = open();
        let summary = db
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "mem_summary".into(),
                    body: body_for(MemoryRecordKind::TaskSummary),
                    scope: MemoryScope::default(),
                    sources: vec![NewMemorySource {
                        source_id: "source_task".into(),
                        kind: MemorySourceKind::Task,
                        source_ref: "task_7".into(),
                        note: Some(" 来自已验证任务 ".into()),
                    }],
                },
                20,
            )
            .unwrap();
        let evidence = create_kind(
            &mut db,
            MemoryRecordKind::MessageEvidence,
            MemoryActor::System,
        );
        let before_summary = summary.body.clone();
        let before_evidence = evidence.body.clone();
        db.attach_memory_source(
            MemoryActor::System,
            &evidence.memory_id,
            &NewMemorySource {
                source_id: "source_turn".into(),
                kind: MemorySourceKind::ConversationTurn,
                source_ref: "turn_9".into(),
                note: None,
            },
            21,
        )
        .unwrap();
        let link = db
            .link_memories(
                MemoryActor::Agent,
                &NewMemoryLink {
                    link_id: "link_1".into(),
                    from_memory_id: summary.memory_id.clone(),
                    to_memory_id: evidence.memory_id.clone(),
                    relation: MemoryRelation::Associates,
                },
                22,
            )
            .unwrap();
        assert_eq!(link.relation, MemoryRelation::Associates);
        let summary_detail = db.memory_detail(&summary.memory_id).unwrap();
        let evidence_detail = db.memory_detail(&evidence.memory_id).unwrap();
        assert_eq!(summary_detail.record.body, before_summary);
        assert_eq!(evidence_detail.record.body, before_evidence);
        assert_eq!(summary_detail.sources.len(), 1);
        assert_eq!(summary_detail.sources[0].kind, MemorySourceKind::Task);
        assert_eq!(
            summary_detail.sources[0].note.as_deref(),
            Some("来自已验证任务")
        );
        assert_eq!(summary_detail.links, evidence_detail.links);
        assert!(matches!(
            db.memory_detail("missing"),
            Err(StorageError::MemoryNotFound(_))
        ));
        assert!(matches!(
            db.list_memory_sources("missing"),
            Err(StorageError::MemoryNotFound(_))
        ));
        assert!(db
            .link_memories(
                MemoryActor::Agent,
                &NewMemoryLink {
                    link_id: "link_self".into(),
                    from_memory_id: summary.memory_id.clone(),
                    to_memory_id: summary.memory_id,
                    relation: MemoryRelation::Contradicts,
                },
                23,
            )
            .is_err());
    }

    #[test]
    fn database_rejects_cross_layer_rows_and_loose_mutability() {
        let db = open();
        for kind in all_kinds() {
            let wrong = match kind.layer() {
                MemoryLayer::L0 => MemoryLayer::L3,
                _ => MemoryLayer::L0,
            };
            let err = insert_raw(
                &db,
                &format!("bad_{}", kind.as_str()),
                wrong.as_str(),
                kind.as_str(),
                "agent",
                "agent_mutable",
                &body_for(kind),
            );
            assert!(err.is_err(), "{kind:?} must not cross layers");
        }
        let mismatched = insert_raw(
            &db,
            "bad_mutability",
            "L2",
            "preference",
            "user",
            "agent_mutable",
            &body_for(MemoryRecordKind::Preference),
        );
        assert!(mismatched.is_err());
        let transcript =
            insert_raw_content(&db, "bad_transcript", "L0", "recent_turn", "\"整段原文\"");
        assert!(transcript.is_err());
    }

    #[test]
    fn author_scope_and_text_limits_are_preserved() {
        let mut db = open();
        let user_preference = create_kind(&mut db, MemoryRecordKind::Preference, MemoryActor::User);
        assert_eq!(user_preference.author, MemoryAuthor::User);
        assert_eq!(user_preference.mutability, MemoryMutability::UserReadonly);
        let system_rule = create_kind(&mut db, MemoryRecordKind::SafetyRule, MemoryActor::System);
        assert_eq!(system_rule.author, MemoryAuthor::System);
        assert_eq!(system_rule.mutability, MemoryMutability::SystemReadonly);
        let scoped = db
            .list_memories(&MemoryQuery {
                user_id: Some("user_1".into()),
                layer: Some(MemoryLayer::L2),
                author: Some(MemoryAuthor::User),
                ..MemoryQuery::default()
            })
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].memory_id, user_preference.memory_id);
        let excerpt = "句".repeat(501);
        let rejected = db.create_memory(
            MemoryActor::Agent,
            &NewMemory {
                memory_id: "mem_long_turn".into(),
                body: MemoryBody::RecentTurn {
                    turn_ref: "turn_long".into(),
                    excerpt,
                },
                scope: MemoryScope::default(),
                sources: Vec::new(),
            },
            30,
        );
        assert!(matches!(rejected, Err(StorageError::InvalidMemory(_))));
        assert!(db.load_memory("mem_long_turn").unwrap().is_none());
    }

    #[test]
    fn agent_cannot_rewrite_user_preferences_or_personality() {
        let mut db = open();
        let preference = db
            .create_memory(
                MemoryActor::User,
                &NewMemory {
                    memory_id: "pref_user".into(),
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "zh-CN".into(),
                    },
                    scope: MemoryScope::default(),
                    sources: vec![NewMemorySource {
                        source_id: "src_user".into(),
                        kind: MemorySourceKind::UserEntry,
                        source_ref: "settings".into(),
                        note: None,
                    }],
                },
                40,
            )
            .unwrap();
        let personality = db
            .create_personality(
                MemoryActor::User,
                "persona_user",
                &personality_draft("助手", true),
                41,
            )
            .unwrap();
        assert_eq!(personality.version, 1);
        assert_eq!(personality.author, MemoryAuthor::User);
        assert_eq!(personality.mutability, MemoryMutability::UserReadonly);

        assert!(matches!(
            db.revise_memory(
                MemoryActor::Agent,
                &preference.memory_id,
                &MemoryRevision {
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "en".into(),
                    },
                    scope: MemoryScope::default(),
                },
                42,
            ),
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                record_class: "偏好",
                author: "user",
            })
        ));
        assert!(matches!(
            db.delete_memory(MemoryActor::Agent, &preference.memory_id),
            Err(StorageError::OwnershipDenied {
                record_class: "偏好",
                ..
            })
        ));
        assert!(matches!(
            db.attach_memory_source(
                MemoryActor::Agent,
                &preference.memory_id,
                &NewMemorySource {
                    source_id: "src_agent".into(),
                    kind: MemorySourceKind::System,
                    source_ref: "guess".into(),
                    note: None,
                },
                43,
            ),
            Err(StorageError::OwnershipDenied { .. })
        ));
        let stored = db.load_memory(&preference.memory_id).unwrap().unwrap();
        assert_eq!(stored.body, preference.body);
        assert_eq!(stored.updated_at_ms, preference.updated_at_ms);
        assert_eq!(
            db.list_memory_sources(&preference.memory_id).unwrap().len(),
            1
        );

        assert!(matches!(
            db.create_personality(
                MemoryActor::Agent,
                "persona_agent",
                &personality_draft("冒充", true),
                44,
            ),
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                record_class: "人格",
                ..
            })
        ));
        assert!(matches!(
            db.revise_personality(
                MemoryActor::Agent,
                "persona_user",
                &personality_draft("改写", true),
                45,
            ),
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                record_class: "人格",
                author: "user",
            })
        ));
        assert!(matches!(
            db.delete_personality(MemoryActor::Agent, "persona_user"),
            Err(StorageError::OwnershipDenied {
                record_class: "人格",
                ..
            })
        ));
        let denied_history = db.list_personality_versions("persona_user").unwrap();
        assert_eq!(denied_history.len(), 1);
        assert_eq!(denied_history[0].identity, "助手");

        let revised = db
            .revise_personality(
                MemoryActor::User,
                "persona_user",
                &personality_draft("研究员", true),
                46,
            )
            .unwrap();
        assert_eq!(revised.version, 2);
        assert_eq!(revised.identity, "研究员");
        let history = db.list_personality_versions("persona_user").unwrap();
        assert_eq!(history[0].identity, "助手");
        assert!(!history[0].active);
        assert_eq!(history[1].identity, "研究员");
        assert!(history[1].active);

        let updated = db
            .revise_memory(
                MemoryActor::User,
                &preference.memory_id,
                &MemoryRevision {
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "zh-Hans".into(),
                    },
                    scope: MemoryScope::default(),
                },
                47,
            )
            .unwrap();
        match updated.body {
            MemoryBody::Preference { value, .. } => assert_eq!(value, "zh-Hans"),
            other => panic!("preference body changed kind: {other:?}"),
        }
        assert!(db
            .list_memories(&MemoryQuery::default())
            .unwrap()
            .iter()
            .all(|record| record.memory_id != "persona_user"));
        assert!(db
            .list_personalities()
            .unwrap()
            .iter()
            .any(|record| record.personality_id == "persona_user"));
        assert!(db.connection.execute(
            "INSERT INTO personality_records(
                personality_id, version, author_kind, mutability,
                identity, tone, verbosity, language, initiative,
                behavior_boundary, tool_policy, voice, active, created_at_ms
             ) VALUES ('persona_bad',1,'agent','agent_mutable','a','b','c','d','e','f','g','h',0,1)",
            [],
        ).is_err());
    }

    #[test]
    fn agent_correction_does_not_rewrite_user_or_system_records() {
        let mut db = open();
        let user_preference = db
            .create_memory(
                MemoryActor::User,
                &NewMemory {
                    memory_id: "pref_keep".into(),
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "zh-CN".into(),
                    },
                    scope: MemoryScope::default(),
                    sources: Vec::new(),
                },
                50,
            )
            .unwrap();
        let profile = db
            .create_memory(
                MemoryActor::User,
                &NewMemory {
                    memory_id: "profile_user".into(),
                    body: body_for(MemoryRecordKind::Profile),
                    scope: MemoryScope::default(),
                    sources: Vec::new(),
                },
                51,
            )
            .unwrap();
        let rule = create_kind(&mut db, MemoryRecordKind::SafetyRule, MemoryActor::System);
        let agent_preference = db
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "pref_agent".into(),
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "agent-note".into(),
                    },
                    scope: MemoryScope::default(),
                    sources: Vec::new(),
                },
                52,
            )
            .unwrap();
        let revised = db
            .revise_memory(
                MemoryActor::Agent,
                &agent_preference.memory_id,
                &MemoryRevision {
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "agent-revised".into(),
                    },
                    scope: MemoryScope::default(),
                },
                53,
            )
            .unwrap();
        assert_eq!(revised.author, MemoryAuthor::Agent);
        assert!(matches!(
            db.revise_memory(
                MemoryActor::Agent,
                &agent_preference.memory_id,
                &MemoryRevision {
                    body: body_for(MemoryRecordKind::Profile),
                    scope: MemoryScope::default(),
                },
                54,
            ),
            Err(StorageError::InvalidMemory(_))
        ));
        assert!(matches!(
            db.load_memory(&agent_preference.memory_id).unwrap().unwrap().body,
            MemoryBody::Preference { ref value, .. } if value == "agent-revised"
        ));

        db.link_memories(
            MemoryActor::Agent,
            &NewMemoryLink {
                link_id: "link_correction".into(),
                from_memory_id: agent_preference.memory_id.clone(),
                to_memory_id: user_preference.memory_id.clone(),
                relation: MemoryRelation::Supersedes,
            },
            55,
        )
        .unwrap();
        match db
            .load_memory(&user_preference.memory_id)
            .unwrap()
            .unwrap()
            .body
        {
            MemoryBody::Preference { value, .. } => assert_eq!(value, "zh-CN"),
            other => panic!("user preference was rewritten: {other:?}"),
        }
        assert!(matches!(
            db.link_memories(
                MemoryActor::Agent,
                &NewMemoryLink {
                    link_id: "link_from_user".into(),
                    from_memory_id: user_preference.memory_id,
                    to_memory_id: agent_preference.memory_id,
                    relation: MemoryRelation::Supersedes,
                },
                56,
            ),
            Err(StorageError::OwnershipDenied {
                actor: "agent",
                record_class: "偏好",
                author: "user",
            })
        ));
        assert!(matches!(
            db.revise_memory(
                MemoryActor::Agent,
                &profile.memory_id,
                &MemoryRevision {
                    body: body_for(MemoryRecordKind::Profile),
                    scope: MemoryScope::default(),
                },
                57,
            ),
            Err(StorageError::OwnershipDenied {
                record_class: "记忆",
                author: "user",
                ..
            })
        ));
        assert!(matches!(
            db.revise_memory(
                MemoryActor::Agent,
                &rule.memory_id,
                &MemoryRevision {
                    body: body_for(MemoryRecordKind::SafetyRule),
                    scope: MemoryScope::default(),
                },
                58,
            ),
            Err(StorageError::OwnershipDenied {
                author: "system",
                ..
            })
        ));
        assert!(matches!(
            db.revise_memory(
                MemoryActor::User,
                &rule.memory_id,
                &MemoryRevision {
                    body: MemoryBody::SafetyRule {
                        statement: "用户改写系统规则".into(),
                    },
                    scope: MemoryScope::default(),
                },
                59,
            ),
            Err(StorageError::OwnershipDenied { .. })
        ));
        let system_revision = db
            .revise_memory(
                MemoryActor::System,
                &rule.memory_id,
                &MemoryRevision {
                    body: MemoryBody::SafetyRule {
                        statement: "系统更新后的确认边界".into(),
                    },
                    scope: MemoryScope::default(),
                },
                60,
            )
            .unwrap();
        assert_eq!(system_revision.author, MemoryAuthor::System);
        assert!(matches!(
            db.revise_memory(
                MemoryActor::System,
                "pref_keep",
                &MemoryRevision {
                    body: MemoryBody::Preference {
                        key: "reply.language".into(),
                        value: "system-override".into(),
                    },
                    scope: MemoryScope::default(),
                },
                61,
            ),
            Err(StorageError::OwnershipDenied {
                actor: "system",
                record_class: "偏好",
                author: "user",
            })
        ));
    }

    fn personality_draft(identity: &str, active: bool) -> PersonalityDraft {
        PersonalityDraft {
            identity: identity.into(),
            tone: "平静".into(),
            verbosity: "简短".into(),
            language: "zh-CN".into(),
            initiative: "低".into(),
            behavior_boundary: "先确认外部副作用".into(),
            tool_policy: "只读默认可执行".into(),
            voice: "不自动播报后台任务".into(),
            evolution_note: None,
            active,
        }
    }

    fn layer_index(layer: MemoryLayer) -> usize {
        match layer {
            MemoryLayer::L0 => 0,
            MemoryLayer::L1 => 1,
            MemoryLayer::L2 => 2,
            MemoryLayer::L3 => 3,
            MemoryLayer::L4 => 4,
            MemoryLayer::L5 => 5,
        }
    }

    fn insert_raw(
        db: &Storage,
        id: &str,
        layer: &str,
        kind: &str,
        author: &str,
        mutability: &str,
        body: &MemoryBody,
    ) -> rusqlite::Result<usize> {
        let content = serde_json::to_string(body).expect("body should serialize");
        insert_raw_content_authored(db, id, layer, kind, author, mutability, &content)
    }

    fn insert_raw_content(
        db: &Storage,
        id: &str,
        layer: &str,
        kind: &str,
        content: &str,
    ) -> rusqlite::Result<usize> {
        insert_raw_content_authored(db, id, layer, kind, "agent", "agent_mutable", content)
    }

    fn insert_raw_content_authored(
        db: &Storage,
        id: &str,
        layer: &str,
        kind: &str,
        author: &str,
        mutability: &str,
        content: &str,
    ) -> rusqlite::Result<usize> {
        db.connection.execute(
            "INSERT INTO memories(
                memory_id, layer, record_kind, content_json, author_kind, mutability,
                created_at_ms, updated_at_ms
             ) VALUES (?1,?2,?3,?4,?5,?6,1,1)",
            params![id, layer, kind, content, author, mutability],
        )
    }
}
