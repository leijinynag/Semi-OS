//! 记忆的自动写入、范围检索、渐进加载、会话压缩和人格运行时组装。
//!
//! 长期记忆写入必须先过确定性过滤，再调用 [`Storage::create_memory`] 与
//! [`Storage::link_memories`]。这两条既有接口持有作者门禁：Agent 不能改用户行，
//! 冲突只能新增记录并指向旧记录。本模块不调用 [`Storage::revise_memory`]，
//! 因此修正路径不会把用户偏好或人格原地改写。
//!
//! 会话压缩不走 [`Storage::write_memory`]。那条流水线会拒绝 L0，避免摘要被当成
//! 长期记忆。压缩仍用 `create_memory` 记下真实作者，并在落库前拒绝秘密、噪音和
//! 未过滤转储。等价正文不覆盖；内容不同时只新增摘要，并用 contradicts 或
//! supersedes 指向旧行。
//!
//! 检索先按用户、工作区、应用、任务和 Skill 收窄，再做全文匹配。调用方拿不到
//! 其他仓库的行，也没有“倒出整库”的接口；返回条数有上限，并且每条都带来源。
//!
//! 渐进包是给 Host 的有序材料，不是完整提示词组装。顺序固定为 Host 策略、
//! 紧凑人格、L1、L0、再按阶段追加 L2–L5。普通轮次只用基础包：紧凑人格、L1、
//! 当前项目身份和少量高置信 L2。超出调用方给出的 token 预算时截断，不能靠把
//! 预算调大来一次性装入全部 L2–L5。具体预算数字仍未决，所以预算由 Host 传入。
//! 紧凑人格只读当前生效的 `personality_records`，组装过程不写人格、不改作者。

use crate::memory::{actor_may_mutate, check_memory_id};
use crate::{
    MemoryActor, MemoryAuthor, MemoryBody, MemoryLayer, MemoryLink, MemoryMutability, MemoryRecord,
    MemoryRecordKind, MemoryRelation, MemoryScope, MemorySource, NewMemory, NewMemoryLink,
    NewMemorySource, Storage, StorageError, StorageResult,
};
use rusqlite::{params, OptionalExtension};
use std::collections::{HashMap, HashSet};

const HIGH_CONFIDENCE: u8 = 70;
const BASE_L2_LIMIT: usize = 4;
const CONTEXT_L2_LIMIT: usize = 4;
const CONTEXT_L3_LIMIT: usize = 4;
const DEEP_L4_LIMIT: usize = 4;
const SEARCH_L5_LIMIT: usize = 3;
const CURRENT_TASK_L0_LIMIT: usize = 4;
/// 检索上限。范围过滤之后仍可能命中很多行，上限避免把整库交回调用方。
const MAX_RECALL: usize = 12;

const SECRET_MARKERS: &[&str] = &[
    "api_key",
    "api-key",
    "api key",
    "apikey",
    "password",
    "passwd",
    "private key",
    "private_key",
    "secret_key",
    "client_secret",
    "begin private key",
    "authorization:",
    "bearer ",
    "set-cookie",
    "cookie:",
    "密码",
    "密钥",
    "口令",
    "秘钥",
];

const NOISE_TEXT: &[&str] = &[
    "嗯",
    "嗯嗯",
    "嗯嗯嗯",
    "哦",
    "哦哦",
    "啊",
    "啊啊",
    "啊这",
    "ok",
    "okay",
    "好",
    "好的",
    "行",
    "可以",
    "谢谢",
    "谢谢你",
    "thanks",
    "thankyou",
    "thx",
    "hi",
    "hello",
    "hey",
    "你好",
    "您好",
    "哈哈",
    "哈哈哈",
    "haha",
    "lol",
    "收到",
    "对",
    "是",
    "是的",
    "yes",
    "no",
    "yep",
    "nope",
];

const IDENTITY_MARKERS: &[&str] = &[
    "性格",
    "人格",
    "mbti",
    "introvert",
    "extrovert",
    "我猜",
    "看起来",
    "似乎",
    "推断",
    "猜测",
    "可能是",
    "大概是",
    "应该是",
    "the user seems",
    "the user appears",
    "the user is probably",
    "i think the user",
    "用户可能",
];

/// 自动写入的一条候选。层只能是 L2、L3 或 L5；L0 压缩摘要不能从这里晋升。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryWriteCandidate {
    pub memory_id: String,
    pub body: MemoryBody,
    pub scope: MemoryScope,
    pub sources: Vec<crate::NewMemorySource>,
    /// 0–100。基础包只用高置信 L2，低分记录可以留下但不进普通轮次。
    pub confidence: u8,
    pub importance: u8,
    /// 指向已有记录的关系。新记录写入后建立链接，不更新目标正文。
    pub conflict: Option<MemoryWriteConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryWriteConflict {
    pub target_memory_id: String,
    pub relation: MemoryRelation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryWriteOutcome {
    Stored {
        record: Box<MemoryRecord>,
        link: Option<MemoryLink>,
    },
    /// 同一范围已有等价正文。不新增行，也不改已有正文。
    Duplicate {
        existing_id: String,
    },
    Rejected(MemoryWriteRejection),
}

/// 过滤器的拒绝原因。原因里不回显原文，避免把秘密写进错误或日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryWriteRejection {
    Secret,
    Noise,
    UnsupportedIdentity,
    /// L0、L1、L4 不走自动写入。压缩摘要留在工作上下文，证据指针也不是长期记忆。
    NotDurableLayer,
    UnfilteredDump,
}

impl MemoryWriteRejection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Noise => "noise",
            Self::UnsupportedIdentity => "unsupported_identity",
            Self::NotDurableLayer => "not_durable_layer",
            Self::UnfilteredDump => "unfiltered_dump",
        }
    }
}

/// 检索范围。`user_id` 必填；未给出的维度只保留该维度为空的记录，避免串到别的仓库、任务或 Skill。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRecallScope {
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub application_id: Option<String>,
    pub task_id: Option<String>,
    pub skill_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryHit {
    pub record: MemoryRecord,
    pub sources: Vec<MemorySource>,
    pub links: Vec<MemoryLink>,
    pub confidence: u8,
    pub importance: u8,
    pub score: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryPackStage {
    /// 普通轮次：紧凑人格、L1、当前任务 L0、项目身份和少量高置信 L2。
    Base,
    /// 请求已经点名项目、应用或任务时，额外带上该范围的 L2/L3。
    Context,
    /// 按查询返回排序后的 L2/L3 摘要和少量 L5 名称，不带 L4 原文指针以外的历史。
    Search,
    /// 只有核对、冲突或 unknown 对账才读取 L4。
    DeepEvidence,
    /// 选中一条 L5 之后才展开正文。未选中时不把全部程序性候选装进来。
    Procedural,
}

/// 渐进包的槽位。数值顺序就是组装顺序，Host 不应再重排。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryPackSlot {
    HostPolicy,
    CompactPersona,
    L1,
    L0,
    L2,
    L3,
    L4,
    L5,
}

impl MemoryPackSlot {
    pub const fn order(self) -> u8 {
        match self {
            Self::HostPolicy => 0,
            Self::CompactPersona => 1,
            Self::L1 => 2,
            Self::L0 => 3,
            Self::L2 => 4,
            Self::L3 => 5,
            Self::L4 => 6,
            Self::L5 => 7,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HostPolicy => "host_policy",
            Self::CompactPersona => "compact_persona",
            Self::L1 => "L1",
            Self::L0 => "L0",
            Self::L2 => "L2",
            Self::L3 => "L3",
            Self::L4 => "L4",
            Self::L5 => "L5",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryPackRequest {
    pub scope: MemoryRecallScope,
    pub stage: MemoryPackStage,
    /// 估算 token 上限。未决的具体预算由 Host 决定；0 表示这一轮不注入记忆材料。
    pub token_budget: u32,
    /// Host 已经决定的策略文本。这里只按顺序放置，不生成、也不改写策略。
    pub host_policy: String,
    pub query: String,
    /// 只在 [`MemoryPackStage::Procedural`] 使用。
    pub selected_memory_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryPackEntry {
    pub slot: MemoryPackSlot,
    pub memory_id: Option<String>,
    pub text: String,
    pub sources: Vec<MemorySource>,
    pub estimated_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryPack {
    pub stage: MemoryPackStage,
    pub entries: Vec<MemoryPackEntry>,
    pub truncated: bool,
    pub estimated_tokens: u32,
}

/// 当前生效人格的紧凑材料。字段来自人格表，不是记忆事实。
///
/// `text` 的行序固定为身份、语气、详略、语言、主动、行为、工具、语音。
/// 演化备注不在这里，避免把人格元数据当成用户事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactPersona {
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
    pub text: String,
}

/// 压缩前仍留在会话里的一回合。只用来判断阈值和续跑窗口，不另写长期记忆。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionTurn {
    pub turn_ref: String,
    pub text: String,
}

/// 已完成动作。回执编号必须原样进入摘要，不能换成“已完成”这类空话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedAction {
    pub summary: String,
    pub receipt_id: String,
}

/// 一次阈值压缩的输入。阈值由 Host 传入，本模块不规定具体 token 数字。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCompactionRequest {
    pub memory_id: String,
    pub scope: MemoryScope,
    pub sources: Vec<NewMemorySource>,
    /// 达到或超过该估算值才写摘要。0 不是合法阈值。
    pub threshold_tokens: u32,
    pub objective: String,
    pub constraints: String,
    pub decisions: String,
    pub completed_actions: Vec<CompletedAction>,
    pub pending: String,
    pub next_step: String,
    pub unknown_outcomes: String,
    pub workspace: String,
    pub application: String,
    pub target: String,
    pub latest_instruction: String,
    pub turns: Vec<CompactionTurn>,
    /// 续跑时保留的最近回合数。最新指令单独保留，不占用这个名额。
    pub retain_recent_turns: usize,
    /// 显式冲突。只接受 contradicts 与 supersedes。缺省时，不同正文自动 supersedes 旧摘要。
    pub conflict: Option<MemoryWriteConflict>,
}

/// 压缩之后会话还能接着跑的材料：L0 摘要、最近回合和最新指令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionReady {
    pub summary: MemoryRecord,
    pub recent_turns: Vec<CompactionTurn>,
    pub latest_instruction: String,
    pub link: Option<MemoryLink>,
    /// 同一范围已有等价摘要。本次没有新增行，也没有改旧正文。
    pub reused_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionOutcome {
    /// 会话还没到阈值。不写摘要，也不把回合抄进记忆表。
    BelowThreshold {
        estimated_tokens: u32,
    },
    Ready(Box<CompactionReady>),
    Rejected(CompactionRejection),
}

/// 压缩被拒绝的原因。原因里不回显原文，避免秘密进入错误文本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionRejection {
    Secret,
    Noise,
    UnfilteredDump,
    /// 必留槽位是空的。拒绝落库，避免丢掉 unknown、回执或最新指令。
    Incomplete,
}

impl CompactionRejection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Noise => "noise",
            Self::UnfilteredDump => "unfiltered_dump",
            Self::Incomplete => "incomplete",
        }
    }
}

struct RankedMemory {
    record: MemoryRecord,
    confidence: u8,
    importance: u8,
    score: i64,
}

impl Storage {
    /// 写入一条低风险记忆。秘密、噪音、未过滤转储和无依据的身份推断会被拒绝且不落库。
    ///
    /// 等价正文在同一范围内视为重复，不覆盖旧行。偏好键相同但值不同，或者调用方
    /// 显式给出冲突时，新增一条调用者自己的记录并建立关系。用户原文保持不变。
    pub fn write_memory(
        &mut self,
        actor: MemoryActor,
        candidate: &MemoryWriteCandidate,
        now: i64,
    ) -> StorageResult<MemoryWriteOutcome> {
        if now < 0 {
            return Err(StorageError::InvalidMemory("时间不能为负".into()));
        }
        if candidate.confidence > 100 || candidate.importance > 100 {
            return Err(StorageError::InvalidMemory(
                "置信度和重要度必须在 0 到 100".into(),
            ));
        }
        check_memory_id(&candidate.memory_id, "记忆编号")?;
        if candidate.sources.is_empty() {
            return Err(StorageError::InvalidMemory("自动写入必须附带来源".into()));
        }
        if let Some(conflict) = &candidate.conflict {
            check_memory_id(&conflict.target_memory_id, "冲突目标")?;
        }
        if let Some(rejection) = screen_body(&candidate.body) {
            return Ok(MemoryWriteOutcome::Rejected(rejection));
        }
        if self.load_memory(&candidate.memory_id)?.is_some() {
            return Err(StorageError::InvalidMemory(
                "记忆编号已存在，自动写入不能覆盖已有行".into(),
            ));
        }

        let existing = self.records_in_exact_scope(candidate.body.kind(), &candidate.scope)?;
        if let Some(duplicate) = existing
            .iter()
            .find(|record| canonical_text(&record.body) == canonical_text(&candidate.body))
        {
            if actor_may_mutate(actor, duplicate.author) {
                self.attach_missing_sources(actor, &duplicate.memory_id, candidate, now)?;
            }
            return Ok(MemoryWriteOutcome::Duplicate {
                existing_id: duplicate.memory_id.clone(),
            });
        }

        let relation = self.resolve_conflict(candidate, &existing)?;
        let record = self.create_memory(
            actor,
            &NewMemory {
                memory_id: candidate.memory_id.clone(),
                body: candidate.body.clone(),
                scope: candidate.scope.clone(),
                sources: candidate.sources.clone(),
            },
            now,
        )?;
        self.insert_admission(
            &record.memory_id,
            candidate.confidence,
            candidate.importance,
        )?;
        let link = if let Some((target_id, relation)) = relation {
            Some(self.link_memories(
                actor,
                &NewMemoryLink {
                    link_id: link_id_for(&record.memory_id, &target_id, relation),
                    from_memory_id: record.memory_id.clone(),
                    to_memory_id: target_id,
                    relation,
                },
                now,
            )?)
        } else {
            None
        };
        Ok(MemoryWriteOutcome::Stored {
            record: Box::new(record),
            link,
        })
    }

    /// 在会话达到阈值时写下 L0 压缩摘要，并返回还能继续任务的上下文。
    ///
    /// 不调用 [`Storage::write_memory`]：那条路径会把 L0 判成非长期记忆并拒绝。
    /// 作者仍由 [`Storage::create_memory`] 决定，冲突只走 [`Storage::link_memories`]。
    /// 摘要不会变成 L2/L3/L5，也不会改人格表。秘密、噪音和未过滤转储在落库前拒绝。
    pub fn compact_session(
        &mut self,
        actor: MemoryActor,
        request: &SessionCompactionRequest,
        now: i64,
    ) -> StorageResult<CompactionOutcome> {
        if now < 0 {
            return Err(StorageError::InvalidMemory("时间不能为负".into()));
        }
        if request.threshold_tokens == 0 {
            return Err(StorageError::InvalidMemory(
                "压缩阈值必须由调用方给出，不能为 0".into(),
            ));
        }
        check_memory_id(&request.memory_id, "记忆编号")?;
        if request.sources.is_empty() {
            return Err(StorageError::InvalidMemory("压缩摘要必须附带来源".into()));
        }
        if let Some(conflict) = &request.conflict {
            check_memory_id(&conflict.target_memory_id, "冲突目标")?;
            if conflict.relation != MemoryRelation::Contradicts
                && conflict.relation != MemoryRelation::Supersedes
            {
                return Err(StorageError::InvalidMemory(
                    "压缩冲突只使用 contradicts 或 supersedes".into(),
                ));
            }
        }
        for action in &request.completed_actions {
            if action.receipt_id.trim().is_empty() || action.summary.trim().is_empty() {
                continue;
            }
            check_memory_id(action.receipt_id.trim(), "回执编号")?;
        }

        let estimated_tokens = session_tokens(&request.turns);
        if estimated_tokens < request.threshold_tokens {
            return Ok(CompactionOutcome::BelowThreshold { estimated_tokens });
        }
        if compaction_incomplete(request) {
            return Ok(CompactionOutcome::Rejected(CompactionRejection::Incomplete));
        }
        if let Some(rejection) = screen_compaction(request) {
            return Ok(CompactionOutcome::Rejected(rejection));
        }

        let body = compaction_body(request);
        if self.load_memory(&request.memory_id)?.is_some() {
            return Err(StorageError::InvalidMemory(
                "记忆编号已存在，压缩不能覆盖已有行".into(),
            ));
        }
        let existing = self.records_in_exact_scope(body.kind(), &request.scope)?;
        if let Some(duplicate) = existing
            .iter()
            .find(|record| canonical_text(&record.body) == canonical_text(&body))
        {
            if actor_may_mutate(actor, duplicate.author) {
                self.attach_compaction_sources(actor, &duplicate.memory_id, request, now)?;
            }
            return Ok(CompactionOutcome::Ready(Box::new(CompactionReady {
                summary: duplicate.clone(),
                recent_turns: retained_turns(request),
                latest_instruction: request.latest_instruction.trim().to_owned(),
                link: None,
                reused_existing: true,
            })));
        }

        let relation = self.resolve_compaction_conflict(request, &body, &existing)?;
        let record = self.create_memory(
            actor,
            &NewMemory {
                memory_id: request.memory_id.clone(),
                body,
                scope: request.scope.clone(),
                sources: request.sources.clone(),
            },
            now,
        )?;
        let link = if let Some((target_id, relation)) = relation {
            Some(self.link_memories(
                actor,
                &NewMemoryLink {
                    link_id: link_id_for(&record.memory_id, &target_id, relation),
                    from_memory_id: record.memory_id.clone(),
                    to_memory_id: target_id,
                    relation,
                },
                now,
            )?)
        } else {
            None
        };
        Ok(CompactionOutcome::Ready(Box::new(CompactionReady {
            summary: record,
            recent_turns: retained_turns(request),
            latest_instruction: request.latest_instruction.trim().to_owned(),
            link,
            reused_existing: false,
        })))
    }

    /// 读取当前生效人格并压成紧凑文本。只读，不追加版本，也不采纳记忆里的事实。
    pub fn load_compact_persona(&self) -> StorageResult<Option<CompactPersona>> {
        let row = self
            .connection
            .query_row(
                "SELECT personality_id, version, author_kind, mutability,
                        identity, tone, verbosity, language, initiative,
                        behavior_boundary, tool_policy, voice
                 FROM personality_records WHERE active = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            personality_id,
            version,
            author_kind,
            mutability,
            identity,
            tone,
            verbosity,
            language,
            initiative,
            behavior,
            tool,
            voice,
        )) = row
        else {
            return Ok(None);
        };
        let author = match author_kind.as_str() {
            "user" => MemoryAuthor::User,
            "system" => MemoryAuthor::System,
            _ => {
                return Err(StorageError::InvalidMemory(
                    "人格作者无效，运行时组装不能接受 Agent 人格".into(),
                ))
            }
        };
        let mutability = match mutability.as_str() {
            "user_readonly" => MemoryMutability::UserReadonly,
            "system_readonly" => MemoryMutability::SystemReadonly,
            _ => {
                return Err(StorageError::InvalidMemory(
                    "人格可变更性无效，运行时组装不能放宽作者约束".into(),
                ))
            }
        };
        if author.mutability() != mutability {
            return Err(StorageError::InvalidMemory(
                "人格作者与可变更性不一致".into(),
            ));
        }
        let text = render_compact_persona(&[
            ("身份", identity.as_str()),
            ("语气", tone.as_str()),
            ("详略", verbosity.as_str()),
            ("语言", language.as_str()),
            ("主动", initiative.as_str()),
            ("行为", behavior.as_str()),
            ("工具", tool.as_str()),
            ("语音", voice.as_str()),
        ]);
        Ok(Some(CompactPersona {
            personality_id,
            version,
            author,
            mutability,
            identity,
            tone,
            verbosity,
            language,
            initiative,
            behavior_boundary: behavior,
            tool_policy: tool,
            voice,
            text,
        }))
    }

    /// 先按范围过滤，再按全文、置信度、重要度和冲突降权排序。
    ///
    /// `limit` 超过 [`MAX_RECALL`] 会被截断。空查询仍受范围和条数限制，不会返回其他仓库的记录。
    pub fn search_memories(
        &self,
        scope: &MemoryRecallScope,
        query: &str,
        limit: usize,
    ) -> StorageResult<Vec<MemoryHit>> {
        if limit == 0 {
            return Err(StorageError::InvalidMemory("检索条数必须大于 0".into()));
        }
        let ranked = self.rank_scoped(scope, query)?;
        self.hydrate_hits(&ranked[..ranked.len().min(limit.min(MAX_RECALL))])
    }

    /// 组装 Host 可直接按顺序使用的渐进包。普通轮次传 [`MemoryPackStage::Base`]。
    pub fn load_memory_pack(&self, request: &MemoryPackRequest) -> StorageResult<MemoryPack> {
        let records = self.load_scoped_records(&request.scope)?;
        let admission = self.load_admission()?;
        let superseded = self.load_superseded_ids()?;
        let tokens = query_tokens(&request.query);
        let mut entries = Vec::new();
        let mut included = HashSet::new();

        if let Some(policy) = nonempty(&request.host_policy) {
            entries.push(pack_entry(
                MemoryPackSlot::HostPolicy,
                None,
                policy,
                Vec::new(),
            ));
        }
        // 人格编号不是记忆编号，不能放进 memory_id，否则会和记忆行混在一起。
        if let Some(persona) = self.load_compact_persona()? {
            entries.push(pack_entry(
                MemoryPackSlot::CompactPersona,
                None,
                persona.text,
                Vec::new(),
            ));
        }
        push_records(
            &mut entries,
            &mut included,
            MemoryPackSlot::L1,
            chronological(
                records
                    .iter()
                    .filter(|record| record.layer == MemoryLayer::L1),
            ),
            self,
        )?;
        let l0: Vec<_> = records
            .iter()
            .filter(|record| {
                record.layer == MemoryLayer::L0
                    && !(record.record_kind == MemoryRecordKind::CompactionSummary
                        && superseded.contains(&record.memory_id))
            })
            .collect();
        push_records(
            &mut entries,
            &mut included,
            MemoryPackSlot::L0,
            newest_then_chronological(&l0, CURRENT_TASK_L0_LIMIT),
            self,
        )?;

        let project = project_identity(&records, &request.scope, &admission, &superseded);
        let mut base_l2 = high_confidence_l2(&records, &admission, &superseded);
        if let Some(project) = project {
            if let Some(position) = base_l2
                .iter()
                .position(|record| record.memory_id == project.memory_id)
            {
                base_l2.remove(position);
            }
            push_records(
                &mut entries,
                &mut included,
                MemoryPackSlot::L2,
                std::iter::once(project),
                self,
            )?;
        }
        base_l2.truncate(BASE_L2_LIMIT);
        push_records(
            &mut entries,
            &mut included,
            MemoryPackSlot::L2,
            base_l2,
            self,
        )?;

        match request.stage {
            MemoryPackStage::Base => {}
            MemoryPackStage::Context => {
                let extra = ranked_records(
                    records.iter().filter(|record| {
                        record.layer == MemoryLayer::L2
                            && !included.contains(&record.memory_id)
                            && !superseded.contains(&record.memory_id)
                            && confidence_of(record, &admission) >= 40
                    }),
                    &admission,
                );
                push_records(
                    &mut entries,
                    &mut included,
                    MemoryPackSlot::L2,
                    extra.into_iter().take(CONTEXT_L2_LIMIT),
                    self,
                )?;
                let episodes = ranked_records(
                    records.iter().filter(|record| {
                        record.layer == MemoryLayer::L3
                            && !superseded.contains(&record.memory_id)
                            && confidence_of(record, &admission) >= 40
                    }),
                    &admission,
                );
                push_records(
                    &mut entries,
                    &mut included,
                    MemoryPackSlot::L3,
                    episodes.into_iter().take(CONTEXT_L3_LIMIT),
                    self,
                )?;
            }
            MemoryPackStage::Search => {
                push_search_hits(
                    self,
                    &mut entries,
                    &mut included,
                    &records,
                    &admission,
                    &superseded,
                    &tokens,
                )?;
            }
            MemoryPackStage::DeepEvidence => {
                let evidence = ranked_records(
                    records.iter().filter(|record| {
                        record.layer == MemoryLayer::L4
                            && text_matches(&render_body(&record.body), &tokens)
                    }),
                    &admission,
                );
                push_records(
                    &mut entries,
                    &mut included,
                    MemoryPackSlot::L4,
                    evidence.into_iter().take(DEEP_L4_LIMIT),
                    self,
                )?;
            }
            MemoryPackStage::Procedural => {
                if let Some(selected) = &request.selected_memory_id {
                    let record = self.selected_procedure(&request.scope, selected)?;
                    push_records(
                        &mut entries,
                        &mut included,
                        MemoryPackSlot::L5,
                        std::iter::once(&record),
                        self,
                    )?;
                }
            }
        }

        Ok(fit_budget(request.stage, entries, request.token_budget))
    }

    fn resolve_conflict(
        &self,
        candidate: &MemoryWriteCandidate,
        existing: &[MemoryRecord],
    ) -> StorageResult<Option<(String, MemoryRelation)>> {
        if let Some(conflict) = &candidate.conflict {
            if conflict.target_memory_id == candidate.memory_id {
                return Err(StorageError::InvalidMemory("记忆不能关联到自己".into()));
            }
            let target = self
                .load_memory(&conflict.target_memory_id)?
                .ok_or_else(|| StorageError::MemoryNotFound(conflict.target_memory_id.clone()))?;
            if !conflict_target_allowed(&candidate.scope, &target.scope) {
                return Err(StorageError::InvalidMemory(
                    "冲突目标超出当前记忆范围".into(),
                ));
            }
            return Ok(Some((target.memory_id, conflict.relation)));
        }
        let Some(key) = preference_key(&candidate.body) else {
            return Ok(None);
        };
        let mut same_key: Vec<_> = existing
            .iter()
            .filter(|record| preference_key(&record.body).as_deref() == Some(key.as_str()))
            .collect();
        same_key.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then(left.memory_id.cmp(&right.memory_id))
        });
        Ok(same_key
            .first()
            .map(|record| (record.memory_id.clone(), MemoryRelation::Contradicts)))
    }

    fn attach_missing_sources(
        &mut self,
        actor: MemoryActor,
        memory_id: &str,
        candidate: &MemoryWriteCandidate,
        now: i64,
    ) -> StorageResult<()> {
        let existing = self.list_memory_sources(memory_id)?;
        for source in &candidate.sources {
            let already = existing
                .iter()
                .any(|item| item.kind == source.kind && item.source_ref == source.source_ref);
            if !already {
                self.attach_memory_source(actor, memory_id, source, now)?;
            }
        }
        Ok(())
    }

    fn records_in_exact_scope(
        &self,
        kind: MemoryRecordKind,
        scope: &MemoryScope,
    ) -> StorageResult<Vec<MemoryRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT memory_id FROM memories
             WHERE record_kind = ?1
               AND ((?2 IS NULL AND user_id IS NULL) OR user_id = ?2)
               AND ((?3 IS NULL AND workspace_id IS NULL) OR workspace_id = ?3)
               AND ((?4 IS NULL AND application_id IS NULL) OR application_id = ?4)
               AND ((?5 IS NULL AND task_id IS NULL) OR task_id = ?5)
               AND ((?6 IS NULL AND skill_id IS NULL) OR skill_id = ?6)
             ORDER BY updated_at_ms DESC, memory_id ASC",
        )?;
        let ids = statement.query_map(
            params![
                kind.as_str(),
                scope.user_id,
                scope.workspace_id,
                scope.application_id,
                scope.task_id,
                scope.skill_id,
            ],
            |row| row.get::<_, String>(0),
        )?;
        let mut records = Vec::new();
        for memory_id in ids {
            let memory_id = memory_id?;
            let Some(record) = self.load_memory(&memory_id)? else {
                return Err(StorageError::InvalidMemory(format!(
                    "范围内的记忆缺失：{memory_id}"
                )));
            };
            records.push(record);
        }
        Ok(records)
    }

    fn rank_scoped(
        &self,
        scope: &MemoryRecallScope,
        query: &str,
    ) -> StorageResult<Vec<RankedMemory>> {
        let tokens = query_tokens(query);
        let admission = self.load_admission()?;
        let superseded = self.load_superseded_ids()?;
        let mut ranked = Vec::new();
        for record in self.load_scoped_records(scope)? {
            let matches = token_matches(&render_body(&record.body), &tokens);
            if !tokens.is_empty() && matches == 0 {
                continue;
            }
            let (confidence, importance) = admission
                .get(&record.memory_id)
                .copied()
                .unwrap_or_else(|| default_scores(&record));
            let score = rank_score(
                confidence,
                importance,
                matches,
                superseded.contains(&record.memory_id),
            );
            ranked.push(RankedMemory {
                record,
                confidence,
                importance,
                score,
            });
        }
        ranked.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then(right.record.updated_at_ms.cmp(&left.record.updated_at_ms))
                .then(left.record.memory_id.cmp(&right.record.memory_id))
        });
        Ok(ranked)
    }

    fn hydrate_hits(&self, ranked: &[RankedMemory]) -> StorageResult<Vec<MemoryHit>> {
        let mut hits = Vec::with_capacity(ranked.len());
        for item in ranked {
            hits.push(MemoryHit {
                sources: self.list_memory_sources(&item.record.memory_id)?,
                links: self.list_memory_links(&item.record.memory_id)?,
                record: item.record.clone(),
                confidence: item.confidence,
                importance: item.importance,
                score: item.score,
            });
        }
        Ok(hits)
    }

    fn load_scoped_records(&self, scope: &MemoryRecallScope) -> StorageResult<Vec<MemoryRecord>> {
        ensure_scope(scope)?;
        let mut statement = self.connection.prepare(
            "SELECT memory_id FROM memories
             WHERE (user_id IS NULL OR user_id = ?1)
               AND (
                    (?2 = 0 AND workspace_id IS NULL)
                    OR (?2 = 1 AND (workspace_id IS NULL OR workspace_id = ?3))
               )
               AND (
                    (?4 = 0 AND application_id IS NULL)
                    OR (?4 = 1 AND (application_id IS NULL OR application_id = ?5))
               )
               AND (
                    (?6 = 0 AND task_id IS NULL)
                    OR (?6 = 1 AND (task_id IS NULL OR task_id = ?7))
               )
               AND (
                    (?8 = 0 AND skill_id IS NULL)
                    OR (?8 = 1 AND (skill_id IS NULL OR skill_id = ?9))
               )
             ORDER BY updated_at_ms DESC, memory_id ASC",
        )?;
        let ids = statement.query_map(
            params![
                scope.user_id,
                i64::from(scope.workspace_id.is_some()),
                scope.workspace_id.clone().unwrap_or_default(),
                i64::from(scope.application_id.is_some()),
                scope.application_id.clone().unwrap_or_default(),
                i64::from(scope.task_id.is_some()),
                scope.task_id.clone().unwrap_or_default(),
                i64::from(scope.skill_id.is_some()),
                scope.skill_id.clone().unwrap_or_default(),
            ],
            |row| row.get::<_, String>(0),
        )?;
        let mut records = Vec::new();
        for memory_id in ids {
            let memory_id = memory_id?;
            let Some(record) = self.load_memory(&memory_id)? else {
                return Err(StorageError::InvalidMemory(format!(
                    "范围内的记忆缺失：{memory_id}"
                )));
            };
            if record_in_scope(scope, &record.scope) {
                records.push(record);
            }
        }
        Ok(records)
    }

    fn selected_procedure(
        &self,
        scope: &MemoryRecallScope,
        memory_id: &str,
    ) -> StorageResult<MemoryRecord> {
        check_memory_id(memory_id, "选中的记忆")?;
        let record = self
            .load_memory(memory_id)?
            .ok_or_else(|| StorageError::MemoryNotFound(memory_id.to_owned()))?;
        if record.layer != MemoryLayer::L5 {
            return Err(StorageError::InvalidMemory(
                "程序性展开只能选择 L5 记录".into(),
            ));
        }
        if !record_in_scope(scope, &record.scope) {
            return Err(StorageError::InvalidMemory("选中的记忆超出当前范围".into()));
        }
        Ok(record)
    }

    fn resolve_compaction_conflict(
        &self,
        request: &SessionCompactionRequest,
        body: &MemoryBody,
        existing: &[MemoryRecord],
    ) -> StorageResult<Option<(String, MemoryRelation)>> {
        if let Some(conflict) = &request.conflict {
            if conflict.target_memory_id == request.memory_id {
                return Err(StorageError::InvalidMemory("记忆不能关联到自己".into()));
            }
            let target = self
                .load_memory(&conflict.target_memory_id)?
                .ok_or_else(|| StorageError::MemoryNotFound(conflict.target_memory_id.clone()))?;
            if !conflict_target_allowed(&request.scope, &target.scope) {
                return Err(StorageError::InvalidMemory(
                    "冲突目标超出当前记忆范围".into(),
                ));
            }
            return Ok(Some((target.memory_id, conflict.relation)));
        }
        let candidate = canonical_text(body);
        let mut older: Vec<_> = existing
            .iter()
            .filter(|record| canonical_text(&record.body) != candidate)
            .collect();
        older.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then(left.memory_id.cmp(&right.memory_id))
        });
        Ok(older
            .first()
            .map(|record| (record.memory_id.clone(), MemoryRelation::Supersedes)))
    }

    fn attach_compaction_sources(
        &mut self,
        actor: MemoryActor,
        memory_id: &str,
        request: &SessionCompactionRequest,
        now: i64,
    ) -> StorageResult<()> {
        let existing = self.list_memory_sources(memory_id)?;
        for source in &request.sources {
            let already = existing
                .iter()
                .any(|item| item.kind == source.kind && item.source_ref == source.source_ref);
            if !already {
                self.attach_memory_source(actor, memory_id, source, now)?;
            }
        }
        Ok(())
    }

    fn insert_admission(
        &self,
        memory_id: &str,
        confidence: u8,
        importance: u8,
    ) -> StorageResult<()> {
        self.connection.execute(
            "INSERT INTO memory_admission(memory_id, confidence, importance) VALUES (?1, ?2, ?3)",
            params![memory_id, i64::from(confidence), i64::from(importance)],
        )?;
        Ok(())
    }

    fn load_admission(&self) -> StorageResult<HashMap<String, (u8, u8)>> {
        let mut statement = self
            .connection
            .prepare("SELECT memory_id, confidence, importance FROM memory_admission")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut scores = HashMap::new();
        for row in rows {
            let (memory_id, confidence, importance) = row?;
            let confidence = u8::try_from(confidence)
                .map_err(|_| StorageError::InvalidMemory(format!("置信度损坏：{memory_id}")))?;
            let importance = u8::try_from(importance)
                .map_err(|_| StorageError::InvalidMemory(format!("重要度损坏：{memory_id}")))?;
            scores.insert(memory_id, (confidence, importance));
        }
        Ok(scores)
    }

    fn load_superseded_ids(&self) -> StorageResult<HashSet<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT to_memory_id FROM memory_links WHERE relation = 'supersedes'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(Into::into)
    }
}

fn push_records<'a, I>(
    entries: &mut Vec<MemoryPackEntry>,
    included: &mut HashSet<String>,
    slot: MemoryPackSlot,
    records: I,
    storage: &Storage,
) -> StorageResult<()>
where
    I: IntoIterator<Item = &'a MemoryRecord>,
{
    for record in records {
        if !included.insert(record.memory_id.clone()) {
            continue;
        }
        entries.push(pack_entry(
            slot,
            Some(record.memory_id.clone()),
            render_body(&record.body),
            storage.list_memory_sources(&record.memory_id)?,
        ));
    }
    Ok(())
}

fn push_search_hits(
    storage: &Storage,
    entries: &mut Vec<MemoryPackEntry>,
    included: &mut HashSet<String>,
    records: &[MemoryRecord],
    admission: &HashMap<String, (u8, u8)>,
    superseded: &HashSet<String>,
    tokens: &[String],
) -> StorageResult<()> {
    for layer in [MemoryLayer::L2, MemoryLayer::L3] {
        let matched = ranked_records(
            records.iter().filter(|record| {
                record.layer == layer
                    && !superseded.contains(&record.memory_id)
                    && text_matches(&render_body(&record.body), tokens)
            }),
            admission,
        );
        push_records(
            entries,
            included,
            slot_for_layer(layer),
            matched.into_iter().take(MAX_RECALL),
            storage,
        )?;
    }
    let procedures = ranked_records(
        records.iter().filter(|record| {
            record.layer == MemoryLayer::L5
                && !superseded.contains(&record.memory_id)
                && text_matches(&procedure_name(&record.body), tokens)
        }),
        admission,
    );
    for record in procedures.into_iter().take(SEARCH_L5_LIMIT) {
        if !included.insert(record.memory_id.clone()) {
            continue;
        }
        let (MemoryBody::SkillCandidate { name, .. } | MemoryBody::WorkflowCandidate { name, .. }) =
            &record.body
        else {
            continue;
        };
        entries.push(pack_entry(
            MemoryPackSlot::L5,
            Some(record.memory_id.clone()),
            name.clone(),
            storage.list_memory_sources(&record.memory_id)?,
        ));
    }
    Ok(())
}

fn slot_for_layer(layer: MemoryLayer) -> MemoryPackSlot {
    match layer {
        MemoryLayer::L0 => MemoryPackSlot::L0,
        MemoryLayer::L1 => MemoryPackSlot::L1,
        MemoryLayer::L2 => MemoryPackSlot::L2,
        MemoryLayer::L3 => MemoryPackSlot::L3,
        MemoryLayer::L4 => MemoryPackSlot::L4,
        MemoryLayer::L5 => MemoryPackSlot::L5,
    }
}

fn project_identity<'a>(
    records: &'a [MemoryRecord],
    scope: &MemoryRecallScope,
    admission: &HashMap<String, (u8, u8)>,
    superseded: &HashSet<String>,
) -> Option<&'a MemoryRecord> {
    let Some(workspace_id) = &scope.workspace_id else {
        return None;
    };
    ranked_records(
        records.iter().filter(|record| {
            record.record_kind == MemoryRecordKind::ProjectFact
                && record.scope.workspace_id.as_ref() == Some(workspace_id)
                && !superseded.contains(&record.memory_id)
                && confidence_of(record, admission) >= HIGH_CONFIDENCE
        }),
        admission,
    )
    .into_iter()
    .next()
}

fn high_confidence_l2<'a>(
    records: &'a [MemoryRecord],
    admission: &HashMap<String, (u8, u8)>,
    superseded: &HashSet<String>,
) -> Vec<&'a MemoryRecord> {
    ranked_records(
        records.iter().filter(|record| {
            record.layer == MemoryLayer::L2
                && !superseded.contains(&record.memory_id)
                && confidence_of(record, admission) >= HIGH_CONFIDENCE
        }),
        admission,
    )
}

fn ranked_records<'a, I>(records: I, admission: &HashMap<String, (u8, u8)>) -> Vec<&'a MemoryRecord>
where
    I: Iterator<Item = &'a MemoryRecord>,
{
    let mut records: Vec<_> = records.collect();
    records.sort_by(|left, right| {
        confidence_of(right, admission)
            .cmp(&confidence_of(left, admission))
            .then(
                admission
                    .get(&right.memory_id)
                    .map(|(_, importance)| *importance)
                    .unwrap_or(50)
                    .cmp(
                        &admission
                            .get(&left.memory_id)
                            .map(|(_, importance)| *importance)
                            .unwrap_or(50),
                    ),
            )
            .then(right.updated_at_ms.cmp(&left.updated_at_ms))
            .then(left.memory_id.cmp(&right.memory_id))
    });
    records
}

fn chronological<'a, I>(records: I) -> Vec<&'a MemoryRecord>
where
    I: Iterator<Item = &'a MemoryRecord>,
{
    let mut records: Vec<_> = records.collect();
    records.sort_by(|left, right| {
        left.created_at_ms
            .cmp(&right.created_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
    records
}

fn newest_then_chronological<'a>(
    records: &[&'a MemoryRecord],
    limit: usize,
) -> Vec<&'a MemoryRecord> {
    let mut newest = records.to_vec();
    newest.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
    newest.truncate(limit);
    chronological(newest.into_iter())
}

fn confidence_of(record: &MemoryRecord, admission: &HashMap<String, (u8, u8)>) -> u8 {
    admission
        .get(&record.memory_id)
        .map(|(confidence, _)| *confidence)
        .unwrap_or_else(|| default_scores(record).0)
}

fn default_scores(record: &MemoryRecord) -> (u8, u8) {
    let confidence = match (record.author, record.layer) {
        (MemoryAuthor::System, MemoryLayer::L1) => 100,
        (MemoryAuthor::User, MemoryLayer::L2) => 90,
        (MemoryAuthor::System, MemoryLayer::L2) => 80,
        (MemoryAuthor::Agent, _) => 50,
        _ => 40,
    };
    (confidence, 50)
}

fn rank_score(confidence: u8, importance: u8, matches: usize, superseded: bool) -> i64 {
    let mut score = i64::from(confidence) * 1_000 + i64::from(importance);
    score += i64::try_from(matches).unwrap_or(i64::MAX) * 50;
    if superseded {
        score -= 100_000;
    }
    score
}

fn pack_entry(
    slot: MemoryPackSlot,
    memory_id: Option<String>,
    text: String,
    sources: Vec<MemorySource>,
) -> MemoryPackEntry {
    let estimated_tokens = estimate_tokens(&text);
    MemoryPackEntry {
        slot,
        memory_id,
        text,
        sources,
        estimated_tokens,
    }
}

fn fit_budget(
    stage: MemoryPackStage,
    mut entries: Vec<MemoryPackEntry>,
    budget: u32,
) -> MemoryPack {
    entries.sort_by_key(|entry| entry.slot.order());
    let mut packed = Vec::new();
    let mut used = 0u32;
    let mut truncated = false;
    for entry in entries {
        if entry.text.is_empty() {
            continue;
        }
        let cost = estimate_tokens(&entry.text);
        if used.saturating_add(cost) <= budget {
            used += cost;
            packed.push(MemoryPackEntry {
                estimated_tokens: cost,
                ..entry
            });
            continue;
        }
        truncated = true;
        let remaining = budget.saturating_sub(used);
        let text = truncate_to_tokens(&entry.text, remaining);
        let cost = estimate_tokens(&text);
        if text.is_empty() || cost > remaining {
            break;
        }
        used += cost;
        packed.push(MemoryPackEntry {
            text,
            estimated_tokens: cost,
            ..entry
        });
        break;
    }
    MemoryPack {
        stage,
        entries: packed,
        truncated,
        estimated_tokens: used,
    }
}

/// 字符数的粗略估算。精确 tokenizer 仍是未决项，Host 用同一估算比较预算。
fn estimate_tokens(text: &str) -> u32 {
    let chars = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
    if chars == 0 {
        0
    } else {
        chars.saturating_add(3) / 4
    }
}

fn truncate_to_tokens(text: &str, budget: u32) -> String {
    if budget == 0 {
        return String::new();
    }
    let max_chars = usize::try_from(budget.saturating_mul(4)).unwrap_or(usize::MAX);
    text.chars().take(max_chars).collect()
}

fn session_tokens(turns: &[CompactionTurn]) -> u32 {
    turns.iter().fold(0u32, |total, turn| {
        total.saturating_add(estimate_tokens(turn.text.trim()))
    })
}

fn retained_turns(request: &SessionCompactionRequest) -> Vec<CompactionTurn> {
    let skip = request
        .turns
        .len()
        .saturating_sub(request.retain_recent_turns);
    request
        .turns
        .iter()
        .skip(skip)
        .map(|turn| CompactionTurn {
            turn_ref: turn.turn_ref.trim().to_owned(),
            text: turn.text.trim().to_owned(),
        })
        .collect()
}

fn compaction_incomplete(request: &SessionCompactionRequest) -> bool {
    [
        request.objective.as_str(),
        request.constraints.as_str(),
        request.decisions.as_str(),
        request.pending.as_str(),
        request.next_step.as_str(),
        request.unknown_outcomes.as_str(),
        request.workspace.as_str(),
        request.application.as_str(),
        request.target.as_str(),
        request.latest_instruction.as_str(),
    ]
    .iter()
    .any(|text| text.trim().is_empty())
        || request
            .completed_actions
            .iter()
            .any(|action| action.summary.trim().is_empty() || action.receipt_id.trim().is_empty())
}

fn compaction_fields(request: &SessionCompactionRequest) -> Vec<&str> {
    let mut fields = vec![
        request.objective.as_str(),
        request.constraints.as_str(),
        request.decisions.as_str(),
        request.pending.as_str(),
        request.next_step.as_str(),
        request.unknown_outcomes.as_str(),
        request.workspace.as_str(),
        request.application.as_str(),
        request.target.as_str(),
        request.latest_instruction.as_str(),
    ];
    for action in &request.completed_actions {
        fields.push(action.summary.as_str());
        fields.push(action.receipt_id.as_str());
    }
    fields
}

/// 只检查将要落库的槽位。回合原文不写入记忆表，因此不因为旧回合里的秘密拒绝整次压缩。
fn screen_compaction(request: &SessionCompactionRequest) -> Option<CompactionRejection> {
    let fields = compaction_fields(request);
    if fields.iter().any(|field| contains_secret(field)) {
        return Some(CompactionRejection::Secret);
    }
    if fields.iter().any(|field| is_unfiltered_dump(field)) {
        return Some(CompactionRejection::UnfilteredDump);
    }
    if fields.iter().all(|field| is_noise_text(field)) {
        return Some(CompactionRejection::Noise);
    }
    None
}

fn format_completed(actions: &[CompletedAction]) -> String {
    if actions.is_empty() {
        "无已完成动作".to_owned()
    } else {
        actions
            .iter()
            .map(|action| {
                format!(
                    "{}（回执 {}）",
                    action.summary.trim(),
                    action.receipt_id.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("；")
    }
}

fn compaction_body(request: &SessionCompactionRequest) -> MemoryBody {
    MemoryBody::CompactionSummary {
        objective: request.objective.trim().to_owned(),
        constraints: request.constraints.trim().to_owned(),
        decisions: request.decisions.trim().to_owned(),
        pending: request.pending.trim().to_owned(),
        unknown_outcomes: request.unknown_outcomes.trim().to_owned(),
        completed_actions: format_completed(&request.completed_actions),
        next_step: request.next_step.trim().to_owned(),
        active_context: format!(
            "工作区：{}；应用：{}；目标：{}",
            request.workspace.trim(),
            request.application.trim(),
            request.target.trim()
        ),
        latest_instruction: request.latest_instruction.trim().to_owned(),
    }
}

fn render_compact_persona(parts: &[(&str, &str)]) -> String {
    parts
        .iter()
        .map(|(label, value)| format!("{label}：{value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn screen_body(body: &MemoryBody) -> Option<MemoryWriteRejection> {
    if !matches!(
        body.kind().layer(),
        MemoryLayer::L2 | MemoryLayer::L3 | MemoryLayer::L5
    ) {
        return Some(MemoryWriteRejection::NotDurableLayer);
    }
    let text = render_body(body);
    if contains_secret(&text) {
        return Some(MemoryWriteRejection::Secret);
    }
    if is_unfiltered_dump(&text) {
        return Some(MemoryWriteRejection::UnfilteredDump);
    }
    if contains_any(&text, IDENTITY_MARKERS) {
        return Some(MemoryWriteRejection::UnsupportedIdentity);
    }
    if field_strings(body).iter().all(|field| is_noise_text(field)) {
        return Some(MemoryWriteRejection::Noise);
    }
    None
}

fn contains_secret(text: &str) -> bool {
    let folded = text.to_lowercase();
    if SECRET_MARKERS.iter().any(|marker| folded.contains(marker)) {
        return true;
    }
    if ["secret", "token"].iter().any(|name| {
        folded.contains(&format!("{name}="))
            || folded.contains(&format!("{name}:"))
            || folded.contains(&format!("{name}："))
            || folded.contains(&format!("{name} ="))
    }) {
        return true;
    }
    ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-", "akia"]
        .iter()
        .any(|prefix| has_prefixed_secret(&folded, prefix))
}

fn has_prefixed_secret(text: &str, prefix: &str) -> bool {
    let mut rest = text;
    while let Some(index) = rest.find(prefix) {
        let after = &rest[index + prefix.len()..];
        let alnum = after.chars().filter(|c| c.is_ascii_alphanumeric()).count();
        let token = after
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
            })
            .count();
        if token >= 8 && alnum >= 8 {
            return true;
        }
        let next = index + prefix.len();
        if next >= rest.len() {
            break;
        }
        rest = &rest[next..];
    }
    false
}

fn is_unfiltered_dump(text: &str) -> bool {
    let folded = text.to_lowercase();
    let dialogue = (folded.contains("user:") && folded.contains("assistant:"))
        || (text.contains("用户：") && (text.contains("助手：") || text.contains("助理：")))
        || (text.contains("用户:") && (text.contains("助手:") || text.contains("助理:")));
    dialogue
        || folded.contains("transcript:")
        || text.contains("对话记录")
        || text.contains("原始对话")
        || text.lines().filter(|line| !line.trim().is_empty()).count() >= 8
}

fn is_noise_text(text: &str) -> bool {
    let key: String = text
        .chars()
        .filter(|character| !character.is_whitespace() && !is_punctuation(*character))
        .flat_map(char::to_lowercase)
        .collect();
    key.is_empty() || NOISE_TEXT.contains(&key.as_str())
}

fn is_punctuation(character: char) -> bool {
    character.is_ascii_punctuation()
        || matches!(
            character,
            '，' | '。' | '！' | '？' | '、' | '；' | '：' | '…' | '—' | '～'
        )
}

fn contains_any(text: &str, markers: &[&str]) -> bool {
    let folded = text.to_lowercase();
    markers
        .iter()
        .any(|marker| text.contains(marker) || folded.contains(&marker.to_lowercase()))
}

fn canonical_text(body: &MemoryBody) -> String {
    render_body(body)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn preference_key(body: &MemoryBody) -> Option<String> {
    match body {
        MemoryBody::Preference { key, .. } => Some(key.trim().to_lowercase()),
        _ => None,
    }
}

fn procedure_name(body: &MemoryBody) -> String {
    match body {
        MemoryBody::SkillCandidate { name, .. } | MemoryBody::WorkflowCandidate { name, .. } => {
            name.clone()
        }
        _ => String::new(),
    }
}

fn render_body(body: &MemoryBody) -> String {
    match body {
        MemoryBody::PiSession {
            runtime_session_ref,
            note,
        } => join_parts([Some(runtime_session_ref.as_str()), note.as_deref()]),
        MemoryBody::RecentTurn { turn_ref, excerpt } => {
            join_parts([Some(turn_ref.as_str()), Some(excerpt.as_str())])
        }
        MemoryBody::CurrentPlan {
            objective,
            next_step,
        } => join_parts([Some(objective.as_str()), Some(next_step.as_str())]),
        MemoryBody::CompactionSummary {
            objective,
            constraints,
            decisions,
            pending,
            unknown_outcomes,
            completed_actions,
            next_step,
            active_context,
            latest_instruction,
        } => join_parts([
            Some(objective.as_str()),
            Some(constraints.as_str()),
            Some(decisions.as_str()),
            Some(completed_actions.as_str()),
            Some(pending.as_str()),
            Some(next_step.as_str()),
            Some(unknown_outcomes.as_str()),
            Some(active_context.as_str()),
            Some(latest_instruction.as_str()),
        ]),
        MemoryBody::SafetyRule { statement }
        | MemoryBody::ToolBoundary { statement }
        | MemoryBody::ConfirmationPolicy { statement } => statement.clone(),
        MemoryBody::Profile { fact } | MemoryBody::ProjectFact { fact } => fact.clone(),
        MemoryBody::Preference { key, value } => format!("{key}\n{value}"),
        MemoryBody::ApplicationHabit { application, habit } => format!("{application}\n{habit}"),
        MemoryBody::TaskSummary { summary }
        | MemoryBody::Decision { summary }
        | MemoryBody::VerifiedOutcome { summary } => summary.clone(),
        MemoryBody::MessageEvidence { reference, note }
        | MemoryBody::TaskEventEvidence { reference, note }
        | MemoryBody::ArtifactEvidence { reference, note }
        | MemoryBody::ReceiptEvidence { reference, note } => {
            join_parts([Some(reference.as_str()), note.as_deref()])
        }
        MemoryBody::WorkflowCandidate { name, summary }
        | MemoryBody::SkillCandidate { name, summary } => format!("{name}\n{summary}"),
    }
}

fn field_strings(body: &MemoryBody) -> Vec<String> {
    match body {
        MemoryBody::Preference { key, value } => vec![key.clone(), value.clone()],
        MemoryBody::ApplicationHabit { application, habit } => {
            vec![application.clone(), habit.clone()]
        }
        MemoryBody::WorkflowCandidate { name, summary }
        | MemoryBody::SkillCandidate { name, summary } => vec![name.clone(), summary.clone()],
        MemoryBody::CurrentPlan {
            objective,
            next_step,
        } => vec![objective.clone(), next_step.clone()],
        other => vec![render_body(other)],
    }
}

fn join_parts<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> String {
    parts
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn query_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(normalize_token)
        .filter(|token| !token.is_empty())
        .collect()
}

fn normalize_token(token: &str) -> String {
    token
        .chars()
        .filter(|character| !is_punctuation(*character))
        .flat_map(char::to_lowercase)
        .collect()
}

fn token_matches(text: &str, tokens: &[String]) -> usize {
    if tokens.is_empty() {
        return 0;
    }
    let folded = text.to_lowercase();
    tokens
        .iter()
        .filter(|token| folded.contains(token.as_str()))
        .count()
}

fn text_matches(text: &str, tokens: &[String]) -> bool {
    tokens.is_empty() || token_matches(text, tokens) == tokens.len()
}

fn nonempty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn ensure_scope(scope: &MemoryRecallScope) -> StorageResult<()> {
    check_memory_id(&scope.user_id, "用户范围")?;
    for (value, field) in [
        (scope.workspace_id.as_deref(), "工作区范围"),
        (scope.application_id.as_deref(), "应用范围"),
        (scope.task_id.as_deref(), "任务范围"),
        (scope.skill_id.as_deref(), "Skill 范围"),
    ] {
        if let Some(value) = value {
            check_memory_id(value, field)?;
        }
    }
    Ok(())
}

fn record_in_scope(scope: &MemoryRecallScope, stored: &MemoryScope) -> bool {
    field_visible(&Some(scope.user_id.clone()), &stored.user_id)
        && field_visible(&scope.workspace_id, &stored.workspace_id)
        && field_visible(&scope.application_id, &stored.application_id)
        && field_visible(&scope.task_id, &stored.task_id)
        && field_visible(&scope.skill_id, &stored.skill_id)
}

fn field_visible(requested: &Option<String>, stored: &Option<String>) -> bool {
    match requested {
        Some(value) => stored.as_ref().is_none_or(|stored| stored == value),
        None => stored.is_none(),
    }
}

fn conflict_target_allowed(candidate: &MemoryScope, target: &MemoryScope) -> bool {
    target_not_narrower(&candidate.user_id, &target.user_id)
        && target_not_narrower(&candidate.workspace_id, &target.workspace_id)
        && target_not_narrower(&candidate.application_id, &target.application_id)
        && target_not_narrower(&candidate.task_id, &target.task_id)
        && target_not_narrower(&candidate.skill_id, &target.skill_id)
}

fn target_not_narrower(candidate: &Option<String>, target: &Option<String>) -> bool {
    match (target, candidate) {
        (None, _) => true,
        (Some(target), Some(candidate)) => target == candidate,
        (Some(_), None) => false,
    }
}

fn link_id_for(from: &str, to: &str, relation: MemoryRelation) -> String {
    let raw = format!("{from}\n{}\n{to}", relation.as_str());
    format!("ln_{:016x}", fnv1a64(raw.as_bytes()))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MemoryActor, MemoryAuthor, MemoryBody, MemoryMutability, MemoryQuery, MemoryRelation,
        MemoryRevision, MemoryScope, MemorySourceKind, NewMemory, NewMemorySource,
        PersonalityDraft, StorageError,
    };

    fn open() -> Storage {
        Storage::open_in_memory().expect("memory database should open")
    }

    fn scope(
        user: &str,
        workspace: Option<&str>,
        application: Option<&str>,
        task: Option<&str>,
        skill: Option<&str>,
    ) -> MemoryScope {
        MemoryScope {
            user_id: Some(user.into()),
            workspace_id: workspace.map(str::to_owned),
            application_id: application.map(str::to_owned),
            task_id: task.map(str::to_owned),
            skill_id: skill.map(str::to_owned),
        }
    }

    fn recall(
        user: &str,
        workspace: Option<&str>,
        application: Option<&str>,
        task: Option<&str>,
        skill: Option<&str>,
    ) -> MemoryRecallScope {
        MemoryRecallScope {
            user_id: user.into(),
            workspace_id: workspace.map(str::to_owned),
            application_id: application.map(str::to_owned),
            task_id: task.map(str::to_owned),
            skill_id: skill.map(str::to_owned),
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

    fn candidate(
        id: &str,
        body: MemoryBody,
        scope: MemoryScope,
        confidence: u8,
    ) -> MemoryWriteCandidate {
        MemoryWriteCandidate {
            memory_id: id.into(),
            body,
            scope,
            sources: vec![source(id)],
            confidence,
            importance: 40,
            conflict: None,
        }
    }

    fn preference(key: &str, value: &str) -> MemoryBody {
        MemoryBody::Preference {
            key: key.into(),
            value: value.into(),
        }
    }

    fn texts_of(db: &Storage) -> String {
        db.list_memories(&MemoryQuery::default())
            .unwrap()
            .into_iter()
            .map(|record| render_body(&record.body))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn write_filters_secrets_noise_dumps_identity_and_keeps_low_risk() {
        let mut db = open();
        let scope = scope("user_a", Some("repo_a"), None, None, None);
        let rejected = [
            (
                "mem_secret",
                preference("editor", "password=fake-value"),
                MemoryWriteRejection::Secret,
            ),
            (
                "mem_token",
                preference("editor", "api_key=fake-memory-key"),
                MemoryWriteRejection::Secret,
            ),
            (
                "mem_noise",
                MemoryBody::Profile {
                    fact: "好的".into(),
                },
                MemoryWriteRejection::Noise,
            ),
            (
                "mem_dump",
                MemoryBody::Profile {
                    fact: "User: 把整段对话存下来\nAssistant: 好的，这是原始转储".into(),
                },
                MemoryWriteRejection::UnfilteredDump,
            ),
            (
                "mem_identity",
                MemoryBody::Profile {
                    fact: "用户性格内向，喜欢独处".into(),
                },
                MemoryWriteRejection::UnsupportedIdentity,
            ),
            (
                "mem_compaction",
                MemoryBody::CompactionSummary {
                    objective: "不要把压缩摘要写成长期记忆".into(),
                    constraints: "留在 L0".into(),
                    decisions: "尚未晋升".into(),
                    pending: "继续当前任务".into(),
                    unknown_outcomes: "没有未核对结果".into(),
                    completed_actions: String::new(),
                    next_step: String::new(),
                    active_context: String::new(),
                    latest_instruction: String::new(),
                },
                MemoryWriteRejection::NotDurableLayer,
            ),
        ];
        for (id, body, reason) in rejected {
            let outcome = db
                .write_memory(
                    MemoryActor::Agent,
                    &candidate(id, body, scope.clone(), 80),
                    10,
                )
                .unwrap();
            assert_eq!(outcome, MemoryWriteOutcome::Rejected(reason));
        }
        assert!(texts_of(&db).is_empty());

        let stored = db
            .write_memory(
                MemoryActor::Agent,
                &candidate("mem_lang", preference("reply.language", "zh-CN"), scope, 90),
                11,
            )
            .unwrap();
        let MemoryWriteOutcome::Stored { record, link } = stored else {
            panic!("low-risk preference should be stored");
        };
        assert!(link.is_none());
        assert_eq!(record.author, MemoryAuthor::Agent);
        assert_eq!(record.mutability, MemoryMutability::AgentMutable);
        assert_eq!(record.layer, MemoryLayer::L2);
        assert_eq!(db.list_memories(&MemoryQuery::default()).unwrap().len(), 1);
        assert!(!texts_of(&db).contains("password"));
        assert!(!texts_of(&db).contains("api_key"));
    }

    #[test]
    fn duplicates_do_not_overwrite_and_user_rows_stay_read_only() {
        let mut db = open();
        let scope = scope("user_a", Some("repo_a"), None, None, None);
        let first = db
            .write_memory(
                MemoryActor::Agent,
                &candidate(
                    "mem_density",
                    preference("density", "compact"),
                    scope.clone(),
                    80,
                ),
                20,
            )
            .unwrap();
        assert!(matches!(first, MemoryWriteOutcome::Stored { .. }));
        let duplicate = db
            .write_memory(
                MemoryActor::Agent,
                &candidate(
                    "mem_density_again",
                    preference("density", "compact"),
                    scope.clone(),
                    80,
                ),
                21,
            )
            .unwrap();
        assert_eq!(
            duplicate,
            MemoryWriteOutcome::Duplicate {
                existing_id: "mem_density".into()
            }
        );

        db.create_memory(
            MemoryActor::User,
            &NewMemory {
                memory_id: "pref_user_lang".into(),
                body: preference("reply.language", "zh-CN"),
                scope: scope.clone(),
                sources: vec![source("user_lang")],
            },
            22,
        )
        .unwrap();
        let before = db.load_memory("pref_user_lang").unwrap().unwrap();
        let echoed = db
            .write_memory(
                MemoryActor::Agent,
                &candidate(
                    "mem_lang_echo",
                    preference("reply.language", "zh-CN"),
                    scope,
                    80,
                ),
                23,
            )
            .unwrap();
        assert_eq!(
            echoed,
            MemoryWriteOutcome::Duplicate {
                existing_id: "pref_user_lang".into()
            }
        );
        let after = db.load_memory("pref_user_lang").unwrap().unwrap();
        assert_eq!(after.body, before.body);
        assert_eq!(after.updated_at_ms, before.updated_at_ms);
        assert_eq!(
            db.list_memory_sources("pref_user_lang").unwrap().len(),
            1,
            "agent duplicate must not attach sources onto a user row"
        );
        assert!(db.load_memory("mem_lang_echo").unwrap().is_none());
    }

    #[test]
    fn correction_adds_an_agent_record_and_does_not_mutate_the_user_row() {
        let mut db = open();
        let scope = scope("user_a", Some("repo_a"), None, None, None);
        db.create_memory(
            MemoryActor::User,
            &NewMemory {
                memory_id: "pref_font".into(),
                body: preference("font", "serif"),
                scope: scope.clone(),
                sources: vec![source("font")],
            },
            30,
        )
        .unwrap();
        db.create_memory(
            MemoryActor::User,
            &NewMemory {
                memory_id: "pref_theme".into(),
                body: preference("theme", "light"),
                scope: scope.clone(),
                sources: vec![source("theme")],
            },
            31,
        )
        .unwrap();
        let theme_before = db.load_memory("pref_theme").unwrap().unwrap();

        let mut hijack = candidate("pref_theme", preference("theme", "dark"), scope.clone(), 90);
        hijack.conflict = Some(MemoryWriteConflict {
            target_memory_id: "pref_theme".into(),
            relation: MemoryRelation::Supersedes,
        });
        assert!(matches!(
            db.write_memory(MemoryActor::Agent, &hijack, 32),
            Err(StorageError::InvalidMemory(_))
        ));
        assert_eq!(
            db.load_memory("pref_theme").unwrap().unwrap().body,
            theme_before.body
        );

        let auto = db
            .write_memory(
                MemoryActor::Agent,
                &candidate(
                    "pref_font_agent",
                    preference("font", "sans"),
                    scope.clone(),
                    88,
                ),
                33,
            )
            .unwrap();
        let MemoryWriteOutcome::Stored { record, link } = auto else {
            panic!("conflicting preference should be stored as a new record");
        };
        assert_eq!(record.author, MemoryAuthor::Agent);
        assert_eq!(record.memory_id, "pref_font_agent");
        let link = link.expect("conflict should create a link");
        assert_eq!(link.relation, MemoryRelation::Contradicts);
        assert_eq!(link.from_memory_id, "pref_font_agent");
        assert_eq!(link.to_memory_id, "pref_font");
        assert_eq!(
            db.load_memory("pref_font").unwrap().unwrap().body,
            preference("font", "serif")
        );

        let mut correction = candidate("pref_theme_agent", preference("theme", "dark"), scope, 92);
        correction.conflict = Some(MemoryWriteConflict {
            target_memory_id: "pref_theme".into(),
            relation: MemoryRelation::Supersedes,
        });
        let stored = db
            .write_memory(MemoryActor::Agent, &correction, 34)
            .unwrap();
        let MemoryWriteOutcome::Stored { link, .. } = stored else {
            panic!("correction should be a new agent record");
        };
        let link = link.expect("supersedes link");
        assert_eq!(link.relation, MemoryRelation::Supersedes);
        assert_eq!(link.from_memory_id, "pref_theme_agent");
        assert_eq!(link.to_memory_id, "pref_theme");
        let theme_after = db.load_memory("pref_theme").unwrap().unwrap();
        assert_eq!(theme_after.body, theme_before.body);
        assert_eq!(theme_after.updated_at_ms, theme_before.updated_at_ms);
        assert_eq!(theme_after.author, MemoryAuthor::User);
        assert_eq!(theme_after.mutability, MemoryMutability::UserReadonly);

        let pack = db
            .load_memory_pack(&MemoryPackRequest {
                scope: recall("user_a", Some("repo_a"), None, None, None),
                stage: MemoryPackStage::Base,
                token_budget: 100_000,
                host_policy: "外部动作必须由 Host 确认".into(),
                query: String::new(),
                selected_memory_id: None,
            })
            .unwrap();
        assert!(joined(&pack).contains("dark"));
        assert!(!joined(&pack).contains("light"));
        assert!(pack
            .entries
            .iter()
            .all(|entry| entry.memory_id.as_deref() != Some("pref_theme")));
        assert_eq!(
            db.load_memory("pref_theme").unwrap().unwrap().body,
            preference("theme", "light")
        );
    }

    #[test]
    fn search_filters_scope_before_text_and_returns_sources() {
        let mut db = open();
        let writes = [
            (
                "mem_vim",
                "user_a",
                Some("repo_a"),
                None,
                None,
                None,
                "编辑器使用 vim",
            ),
            (
                "mem_emacs",
                "user_a",
                Some("repo_b"),
                None,
                None,
                None,
                "编辑器使用 emacs",
            ),
            (
                "mem_nano",
                "user_b",
                Some("repo_a"),
                None,
                None,
                None,
                "编辑器使用 nano",
            ),
            (
                "mem_task_1",
                "user_a",
                Some("repo_a"),
                None,
                Some("task_1"),
                None,
                "任务一的临时字体",
            ),
            (
                "mem_task_2",
                "user_a",
                Some("repo_a"),
                None,
                Some("task_2"),
                None,
                "任务二的临时字体",
            ),
            (
                "mem_textedit",
                "user_a",
                Some("repo_a"),
                Some("TextEdit"),
                None,
                None,
                "TextEdit 先观察再输入",
            ),
            (
                "mem_safari",
                "user_a",
                Some("repo_a"),
                Some("Safari"),
                None,
                None,
                "Safari 不用自动填充",
            ),
        ];
        for (index, (id, user, workspace, application, task, skill, value)) in
            writes.into_iter().enumerate()
        {
            db.write_memory(
                MemoryActor::Agent,
                &candidate(
                    id,
                    preference("editor", value),
                    scope(user, workspace, application, task, skill),
                    80,
                ),
                40 + index as i64,
            )
            .unwrap();
        }
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "mem_skill_a",
                MemoryBody::SkillCandidate {
                    name: "检查清单甲".into(),
                    summary: "包含 vim 核对".into(),
                },
                scope("user_a", Some("repo_a"), None, None, Some("skill_a")),
                80,
            ),
            50,
        )
        .unwrap();
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "mem_skill_b",
                MemoryBody::SkillCandidate {
                    name: "检查清单乙".into(),
                    summary: "另一个 Skill 的步骤".into(),
                },
                scope("user_a", Some("repo_a"), None, None, Some("skill_b")),
                80,
            ),
            51,
        )
        .unwrap();

        let hits = db
            .search_memories(
                &recall("user_a", Some("repo_a"), None, None, None),
                "vim",
                10,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.memory_id, "mem_vim");
        assert_eq!(hits[0].sources.len(), 1);
        assert_eq!(hits[0].sources[0].source_ref, "turn_mem_vim");
        assert!(hits
            .iter()
            .all(|hit| hit.record.scope.user_id.as_deref() == Some("user_a")));
        assert!(hits
            .iter()
            .all(|hit| hit.record.scope.workspace_id.as_deref() == Some("repo_a")));

        let task_hits = db
            .search_memories(
                &recall("user_a", Some("repo_a"), None, Some("task_1"), None),
                "临时字体",
                10,
            )
            .unwrap();
        assert_eq!(
            task_hits
                .iter()
                .map(|hit| hit.record.memory_id.as_str())
                .collect::<Vec<_>>(),
            vec!["mem_task_1"]
        );
        assert!(task_hits.iter().all(|hit| !hit.sources.is_empty()));

        let app_hits = db
            .search_memories(
                &recall("user_a", Some("repo_a"), Some("TextEdit"), None, None),
                "观察",
                10,
            )
            .unwrap();
        assert_eq!(app_hits.len(), 1);
        assert_eq!(app_hits[0].record.memory_id, "mem_textedit");

        let skill_hits = db
            .search_memories(
                &recall("user_a", Some("repo_a"), None, None, Some("skill_a")),
                "检查清单",
                10,
            )
            .unwrap();
        assert_eq!(skill_hits.len(), 1);
        assert_eq!(skill_hits[0].record.memory_id, "mem_skill_a");

        for index in 0..15 {
            db.write_memory(
                MemoryActor::Agent,
                &candidate(
                    &format!("mem_batch_{index}"),
                    preference("batch", &format!("批量条目 {index}")),
                    scope("user_a", Some("repo_a"), None, None, None),
                    70,
                ),
                60 + index,
            )
            .unwrap();
        }
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "mem_batch_other",
                preference("batch", "批量条目 其他仓库"),
                scope("user_a", Some("repo_b"), None, None, None),
                90,
            ),
            80,
        )
        .unwrap();
        let batched = db
            .search_memories(
                &recall("user_a", Some("repo_a"), None, None, None),
                "批量条目",
                100,
            )
            .unwrap();
        let total = db.list_memories(&MemoryQuery::default()).unwrap().len();
        assert!(batched.len() <= MAX_RECALL);
        assert!(total > batched.len());
        assert!(batched
            .iter()
            .all(|hit| hit.record.memory_id != "mem_batch_other"));
        assert!(batched.iter().all(|hit| !hit.sources.is_empty()));
    }

    struct PackFixture {
        l5_ids: Vec<String>,
        low_id: String,
    }

    fn seed_pack(db: &mut Storage) -> PackFixture {
        db.create_personality(
            MemoryActor::User,
            "persona_main",
            &PersonalityDraft {
                identity: "Semi 助手".into(),
                tone: "平静".into(),
                verbosity: "简短".into(),
                language: "zh-CN".into(),
                initiative: "低".into(),
                behavior_boundary: "先确认外部副作用".into(),
                tool_policy: "只读默认可执行".into(),
                voice: "不自动播报后台任务".into(),
                evolution_note: Some("演化备注不是事实".into()),
                active: true,
            },
            100,
        )
        .unwrap();
        db.create_memory(
            MemoryActor::System,
            &NewMemory {
                memory_id: "rule_confirm".into(),
                body: MemoryBody::SafetyRule {
                    statement: "外部副作用需要确认".into(),
                },
                scope: scope("user_a", None, None, None, None),
                sources: vec![],
            },
            101,
        )
        .unwrap();
        for (id, task, objective) in [
            ("plan_task_1", "task_1", "核对当前仓库"),
            ("plan_task_2", "task_2", "另一个任务的目标"),
        ] {
            db.create_memory(
                MemoryActor::System,
                &NewMemory {
                    memory_id: id.into(),
                    body: MemoryBody::CurrentPlan {
                        objective: objective.into(),
                        next_step: "继续".into(),
                    },
                    scope: scope("user_a", Some("repo_a"), None, Some(task), None),
                    sources: vec![],
                },
                102,
            )
            .unwrap();
        }
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "fact_repo_a",
                MemoryBody::ProjectFact {
                    fact: "当前仓库是 Semi-OS".into(),
                },
                scope("user_a", Some("repo_a"), None, None, None),
                95,
            ),
            110,
        )
        .unwrap();
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "fact_repo_b",
                MemoryBody::ProjectFact {
                    fact: "另一个仓库的私有事实".into(),
                },
                scope("user_a", Some("repo_b"), None, None, None),
                95,
            ),
            111,
        )
        .unwrap();
        for index in 0..6 {
            db.write_memory(
                MemoryActor::Agent,
                &candidate(
                    &format!("pref_extra_{index}"),
                    preference(&format!("extra.{index}"), &format!("高置信值 {index}")),
                    scope("user_a", Some("repo_a"), None, None, None),
                    90,
                ),
                120 + index,
            )
            .unwrap();
        }
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "pref_low",
                preference("low.confidence", "不要放进基础包"),
                scope("user_a", Some("repo_a"), None, None, None),
                15,
            ),
            130,
        )
        .unwrap();
        for index in 0..6 {
            db.write_memory(
                MemoryActor::Agent,
                &candidate(
                    &format!("episode_{index}"),
                    MemoryBody::TaskSummary {
                        summary: format!("情节摘要 {index}"),
                    },
                    scope("user_a", Some("repo_a"), None, Some("task_1"), None),
                    80,
                ),
                140 + index,
            )
            .unwrap();
            db.create_memory(
                MemoryActor::System,
                &NewMemory {
                    memory_id: format!("evidence_{index}"),
                    body: MemoryBody::MessageEvidence {
                        reference: format!("message:{index}"),
                        note: None,
                    },
                    scope: scope("user_a", Some("repo_a"), None, Some("task_1"), None),
                    sources: vec![source(&format!("evidence_{index}"))],
                },
                150 + index,
            )
            .unwrap();
        }
        let mut l5_ids = Vec::new();
        for index in 0..3 {
            let id = format!("skill_{index}");
            db.write_memory(
                MemoryActor::Agent,
                &candidate(
                    &id,
                    MemoryBody::SkillCandidate {
                        name: format!("流程{index}"),
                        summary: format!("完整流程候选{index}"),
                    },
                    scope("user_a", Some("repo_a"), None, None, Some("skill_a")),
                    85,
                ),
                160 + index,
            )
            .unwrap();
            l5_ids.push(id);
        }
        PackFixture {
            l5_ids,
            low_id: "pref_low".into(),
        }
    }

    fn pack_scope() -> MemoryRecallScope {
        recall(
            "user_a",
            Some("repo_a"),
            None,
            Some("task_1"),
            Some("skill_a"),
        )
    }

    fn request(
        stage: MemoryPackStage,
        budget: u32,
        query: &str,
        selected: Option<&str>,
    ) -> MemoryPackRequest {
        MemoryPackRequest {
            scope: pack_scope(),
            stage,
            token_budget: budget,
            host_policy: "外部动作必须由 Host 确认".into(),
            query: query.into(),
            selected_memory_id: selected.map(str::to_owned),
        }
    }

    fn joined(pack: &MemoryPack) -> String {
        pack.entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn assert_order(pack: &MemoryPack) {
        let ranks: Vec<_> = pack
            .entries
            .iter()
            .map(|entry| entry.slot.order())
            .collect();
        assert!(ranks.windows(2).all(|window| window[0] <= window[1]));
    }

    #[test]
    fn base_pack_is_ordered_and_omits_deeper_layers() {
        let mut db = open();
        let fixture = seed_pack(&mut db);
        let pack = db
            .load_memory_pack(&request(
                MemoryPackStage::Base,
                100_000,
                "情节摘要",
                Some(&fixture.l5_ids[0]),
            ))
            .unwrap();
        assert!(!pack.truncated);
        assert_eq!(
            pack.entries.first().map(|entry| entry.slot),
            Some(MemoryPackSlot::HostPolicy)
        );
        assert_order(&pack);
        let text = joined(&pack);
        let persona = pack
            .entries
            .iter()
            .find(|entry| entry.slot == MemoryPackSlot::CompactPersona)
            .unwrap();
        assert!(persona.text.contains("身份：Semi 助手"));
        assert!(!persona.text.contains("演化备注不是事实"));
        assert!(text.contains("外部副作用需要确认"));
        assert!(text.contains("核对当前仓库"));
        assert!(!text.contains("另一个任务的目标"));
        assert!(text.contains("当前仓库是 Semi-OS"));
        assert!(!text.contains("另一个仓库的私有事实"));
        assert!(!text.contains("不要放进基础包"));
        assert!(!text.contains("情节摘要"));
        assert!(!text.contains("完整流程候选"));
        assert!(!text.contains("message:"));
        let preference_count = pack
            .entries
            .iter()
            .filter(|entry| {
                entry
                    .memory_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("pref_extra_"))
            })
            .count();
        assert!(preference_count <= BASE_L2_LIMIT);
        assert!(preference_count >= 1);
        assert!(pack
            .entries
            .iter()
            .all(|entry| entry.memory_id.as_deref() != Some(fixture.low_id.as_str())));
        assert!(pack.entries.iter().all(|entry| {
            !matches!(
                entry.slot,
                MemoryPackSlot::L3 | MemoryPackSlot::L4 | MemoryPackSlot::L5
            )
        }));
        assert_eq!(
            db.list_memories(&MemoryQuery::default())
                .unwrap()
                .iter()
                .filter(|record| record.layer == MemoryLayer::L3)
                .count(),
            6,
            "deeper rows stay stored while the base pack leaves them out"
        );
    }

    #[test]
    fn pack_truncates_when_the_budget_is_exceeded() {
        let mut db = open();
        seed_pack(&mut db);
        let pack = db
            .load_memory_pack(&request(MemoryPackStage::Base, 1, "", None))
            .unwrap();
        assert!(pack.truncated);
        assert!(pack.estimated_tokens <= 1);
        assert!(pack
            .entries
            .iter()
            .all(|entry| entry.slot.order() <= MemoryPackSlot::L2.order()));
        assert!(pack.entries.iter().all(|entry| {
            !matches!(
                entry.slot,
                MemoryPackSlot::L3 | MemoryPackSlot::L4 | MemoryPackSlot::L5
            )
        }));
        assert!(!joined(&pack).contains("情节摘要"));
        assert!(!joined(&pack).contains("完整流程候选"));
    }

    #[test]
    fn deeper_stages_load_only_the_requested_layer() {
        let mut db = open();
        let fixture = seed_pack(&mut db);
        let context = db
            .load_memory_pack(&request(MemoryPackStage::Context, 100_000, "", None))
            .unwrap();
        assert_order(&context);
        let episodes = context
            .entries
            .iter()
            .filter(|entry| entry.slot == MemoryPackSlot::L3)
            .count();
        assert!((1..=CONTEXT_L3_LIMIT).contains(&episodes));
        assert!(context
            .entries
            .iter()
            .all(|entry| { !matches!(entry.slot, MemoryPackSlot::L4 | MemoryPackSlot::L5) }));

        let search = db
            .load_memory_pack(&request(MemoryPackStage::Search, 100_000, "情节摘要", None))
            .unwrap();
        assert!(search
            .entries
            .iter()
            .any(|entry| entry.slot == MemoryPackSlot::L3));
        assert!(search
            .entries
            .iter()
            .all(|entry| entry.slot != MemoryPackSlot::L4));
        assert!(search
            .entries
            .iter()
            .filter(|entry| entry.slot == MemoryPackSlot::L3)
            .all(|entry| !entry.sources.is_empty()));

        let deep = db
            .load_memory_pack(&request(
                MemoryPackStage::DeepEvidence,
                100_000,
                "message",
                None,
            ))
            .unwrap();
        let evidence = deep
            .entries
            .iter()
            .filter(|entry| entry.slot == MemoryPackSlot::L4)
            .count();
        assert!((1..=DEEP_L4_LIMIT).contains(&evidence));
        assert!(deep
            .entries
            .iter()
            .all(|entry| entry.slot != MemoryPackSlot::L5));
        assert!(deep
            .entries
            .iter()
            .all(|entry| entry.slot != MemoryPackSlot::L3));

        let procedural = db
            .load_memory_pack(&request(
                MemoryPackStage::Procedural,
                100_000,
                "",
                Some(&fixture.l5_ids[0]),
            ))
            .unwrap();
        assert_order(&procedural);
        let procedures: Vec<_> = procedural
            .entries
            .iter()
            .filter(|entry| entry.slot == MemoryPackSlot::L5)
            .collect();
        assert_eq!(procedures.len(), 1);
        assert_eq!(
            procedures[0].memory_id.as_deref(),
            Some(fixture.l5_ids[0].as_str())
        );
        assert!(procedures[0].text.contains("完整流程候选0"));
        assert!(!joined(&procedural).contains("完整流程候选1"));
        assert!(procedures[0].sources.len() == 1);
    }

    fn filler(tokens: u32) -> String {
        let chars = usize::try_from(tokens.saturating_mul(4).saturating_sub(3)).unwrap_or(1);
        "a".repeat(chars.max(1))
    }

    fn compaction_request(id: &str, turns: Vec<CompactionTurn>) -> SessionCompactionRequest {
        SessionCompactionRequest {
            memory_id: id.into(),
            scope: scope(
                "user_a",
                Some("repo_a"),
                Some("TextEdit"),
                Some("task_1"),
                None,
            ),
            sources: vec![NewMemorySource {
                source_id: format!("src_{id}"),
                kind: MemorySourceKind::PiSession,
                source_ref: format!("pi_{id}"),
                note: None,
            }],
            threshold_tokens: 1,
            objective: "整理桌面笔记".into(),
            constraints: "不发送外部消息".into(),
            decisions: "决定旧稿，不把性格推断写成事实".into(),
            completed_actions: vec![CompletedAction {
                summary: "已观察窗口".into(),
                receipt_id: "receipt_observe_1".into(),
            }],
            pending: "等待确认后输入".into(),
            next_step: "核对 TextEdit 焦点".into(),
            unknown_outcomes: "desktop_click 结果 unknown".into(),
            workspace: "repo_a".into(),
            application: "TextEdit".into(),
            target: "未命名文稿".into(),
            latest_instruction: "打断后改为只输入标题".into(),
            turns,
            retain_recent_turns: 2,
            conflict: None,
        }
    }

    fn sample_turns() -> Vec<CompactionTurn> {
        vec![
            CompactionTurn {
                turn_ref: "turn_old".into(),
                text: format!("{}旧回合记号", filler(8)),
            },
            CompactionTurn {
                turn_ref: "turn_recent_a".into(),
                text: "最近回合甲".into(),
            },
            CompactionTurn {
                turn_ref: "turn_recent_b".into(),
                text: "最近回合乙".into(),
            },
        ]
    }

    fn ready(outcome: CompactionOutcome) -> CompactionReady {
        match outcome {
            CompactionOutcome::Ready(ready) => *ready,
            other => panic!("expected a compaction summary, got {other:?}"),
        }
    }

    #[test]
    fn compaction_keeps_required_fields_on_l0_and_can_continue() {
        let mut db = open();
        db.create_personality(
            MemoryActor::User,
            "persona_main",
            &PersonalityDraft {
                identity: "Semi 助手".into(),
                tone: "平静".into(),
                verbosity: "简短".into(),
                language: "zh-CN".into(),
                initiative: "低".into(),
                behavior_boundary: "先确认外部副作用".into(),
                tool_policy: "只读默认可执行".into(),
                voice: "不自动播报后台任务".into(),
                evolution_note: Some("演化备注不是事实".into()),
                active: true,
            },
            10,
        )
        .unwrap();
        let before = db.list_memories(&MemoryQuery::default()).unwrap().len();
        let outcome = db
            .compact_session(
                MemoryActor::Agent,
                &compaction_request("mem_compact", sample_turns()),
                20,
            )
            .unwrap();
        let ready = ready(outcome);
        assert!(!ready.reused_existing);
        assert!(ready.link.is_none());
        assert_eq!(ready.summary.layer, MemoryLayer::L0);
        assert_eq!(
            ready.summary.record_kind,
            MemoryRecordKind::CompactionSummary
        );
        assert_eq!(ready.summary.author, MemoryAuthor::Agent);
        assert_eq!(ready.summary.mutability, MemoryMutability::AgentMutable);
        let body = render_body(&ready.summary.body);
        for required in [
            "整理桌面笔记",
            "不发送外部消息",
            "决定旧稿",
            "receipt_observe_1",
            "等待确认后输入",
            "核对 TextEdit 焦点",
            "desktop_click 结果 unknown",
            "工作区：repo_a",
            "应用：TextEdit",
            "目标：未命名文稿",
            "打断后改为只输入标题",
        ] {
            assert!(body.contains(required), "missing {required}");
        }
        assert_eq!(
            ready
                .recent_turns
                .iter()
                .map(|turn| turn.turn_ref.as_str())
                .collect::<Vec<_>>(),
            vec!["turn_recent_a", "turn_recent_b"]
        );
        assert_eq!(ready.latest_instruction, "打断后改为只输入标题");
        let stored = texts_of(&db);
        assert!(!stored.contains("旧回合记号"));
        assert!(!stored.contains("最近回合甲"));
        assert_eq!(
            db.list_memories(&MemoryQuery::default()).unwrap().len(),
            before + 1
        );
        assert!(db
            .list_memories(&MemoryQuery {
                record_kind: Some(MemoryRecordKind::Profile),
                ..MemoryQuery::default()
            })
            .unwrap()
            .is_empty());
        let promoted = db
            .write_memory(
                MemoryActor::Agent,
                &candidate(
                    "mem_promoted",
                    ready.summary.body.clone(),
                    ready.summary.scope.clone(),
                    90,
                ),
                21,
            )
            .unwrap();
        assert_eq!(
            promoted,
            MemoryWriteOutcome::Rejected(MemoryWriteRejection::NotDurableLayer)
        );
        assert_eq!(
            db.list_memories(&MemoryQuery::default()).unwrap().len(),
            before + 1
        );

        let pack = db
            .load_memory_pack(&MemoryPackRequest {
                scope: recall(
                    "user_a",
                    Some("repo_a"),
                    Some("TextEdit"),
                    Some("task_1"),
                    None,
                ),
                stage: MemoryPackStage::Base,
                token_budget: 100_000,
                host_policy: "外部动作必须由 Host 确认".into(),
                query: String::new(),
                selected_memory_id: None,
            })
            .unwrap();
        assert!(!pack.truncated);
        assert_order(&pack);
        assert_eq!(
            pack.entries
                .iter()
                .map(|entry| entry.slot)
                .collect::<Vec<_>>(),
            vec![
                MemoryPackSlot::HostPolicy,
                MemoryPackSlot::CompactPersona,
                MemoryPackSlot::L0,
            ]
        );
        let persona = pack
            .entries
            .iter()
            .find(|entry| entry.slot == MemoryPackSlot::CompactPersona)
            .unwrap();
        assert!(persona.text.contains("身份：Semi 助手"));
        assert!(!persona.text.contains("演化备注不是事实"));
        assert!(!persona.text.contains("receipt_observe_1"));
        assert!(!persona.text.contains("性格"));
        let l0 = pack
            .entries
            .iter()
            .find(|entry| entry.slot == MemoryPackSlot::L0)
            .unwrap();
        assert!(l0.text.contains("receipt_observe_1"));
        assert!(l0.text.contains("unknown"));
        assert!(l0.text.contains("打断后改为只输入标题"));
        assert_eq!(
            db.load_personality("persona_main")
                .unwrap()
                .unwrap()
                .version,
            1
        );
    }

    #[test]
    fn compaction_rejects_unsafe_or_incomplete_input_without_writing() {
        let mut db = open();
        let below = compaction_request(
            "mem_below",
            vec![CompactionTurn {
                turn_ref: "turn_short".into(),
                text: filler(4),
            }],
        );
        let mut below = below;
        below.threshold_tokens = 5;
        below.latest_instruction = "password=not-stored".into();
        let outcome = db.compact_session(MemoryActor::Agent, &below, 30).unwrap();
        match outcome {
            CompactionOutcome::BelowThreshold { estimated_tokens } => {
                assert!(estimated_tokens < 5);
                assert!(estimated_tokens > 0);
            }
            other => panic!("short session should stay uncompacted, got {other:?}"),
        }
        assert!(texts_of(&db).is_empty());
        assert!(!texts_of(&db).contains("password"));

        let mut unset = compaction_request("mem_unset", sample_turns());
        unset.threshold_tokens = 0;
        assert!(matches!(
            db.compact_session(MemoryActor::Agent, &unset, 31),
            Err(StorageError::InvalidMemory(_))
        ));

        let mut missing_unknown = compaction_request("mem_missing", sample_turns());
        missing_unknown.unknown_outcomes.clear();
        assert_eq!(
            db.compact_session(MemoryActor::Agent, &missing_unknown, 32)
                .unwrap(),
            CompactionOutcome::Rejected(CompactionRejection::Incomplete)
        );
        let mut missing_receipt = compaction_request("mem_receipt", sample_turns());
        missing_receipt.completed_actions[0].receipt_id.clear();
        assert_eq!(
            db.compact_session(MemoryActor::Agent, &missing_receipt, 33)
                .unwrap(),
            CompactionOutcome::Rejected(CompactionRejection::Incomplete)
        );

        let mut secret = compaction_request("mem_secret", sample_turns());
        secret.latest_instruction = "api_key=fake-session-key".into();
        assert_eq!(
            db.compact_session(MemoryActor::Agent, &secret, 34).unwrap(),
            CompactionOutcome::Rejected(CompactionRejection::Secret)
        );
        let mut noise = compaction_request("mem_noise", sample_turns());
        noise.objective = "好的".into();
        noise.constraints = "好的".into();
        noise.decisions = "好的".into();
        noise.pending = "好的".into();
        noise.next_step = "好的".into();
        noise.unknown_outcomes = "好的".into();
        noise.workspace = "好的".into();
        noise.application = "好的".into();
        noise.target = "好的".into();
        noise.latest_instruction = "好的".into();
        noise.completed_actions.clear();
        assert_eq!(
            db.compact_session(MemoryActor::Agent, &noise, 35).unwrap(),
            CompactionOutcome::Rejected(CompactionRejection::Noise)
        );
        let mut dump = compaction_request("mem_dump", sample_turns());
        dump.decisions = "User: 整段原文 Assistant: 原样保存".into();
        assert_eq!(
            db.compact_session(MemoryActor::Agent, &dump, 36).unwrap(),
            CompactionOutcome::Rejected(CompactionRejection::UnfilteredDump)
        );
        assert!(texts_of(&db).is_empty());
        assert!(!texts_of(&db).contains("api_key"));
        assert!(!texts_of(&db).contains("User:"));

        let mut none_done = compaction_request("mem_none", sample_turns());
        none_done.completed_actions.clear();
        let ready = ready(
            db.compact_session(MemoryActor::Agent, &none_done, 37)
                .unwrap(),
        );
        assert!(render_body(&ready.summary.body).contains("无已完成动作"));
        assert_eq!(ready.summary.layer, MemoryLayer::L0);
    }

    #[test]
    fn compaction_links_conflicts_without_changing_user_rows() {
        let mut db = open();
        let user = ready(
            db.compact_session(
                MemoryActor::User,
                &compaction_request("mem_user", sample_turns()),
                40,
            )
            .unwrap(),
        );
        let user_body = user.summary.body.clone();
        let user_updated = user.summary.updated_at_ms;
        let mut duplicate = compaction_request("mem_dup", sample_turns());
        duplicate.sources[0].source_id = "src_dup".into();
        duplicate.sources[0].source_ref = "pi_dup".into();
        duplicate.conflict = Some(MemoryWriteConflict {
            target_memory_id: "mem_user".into(),
            relation: MemoryRelation::Contradicts,
        });
        let reused = ready(
            db.compact_session(MemoryActor::Agent, &duplicate, 41)
                .unwrap(),
        );
        assert!(reused.reused_existing);
        assert_eq!(reused.summary.memory_id, "mem_user");
        assert!(reused.link.is_none());
        assert_eq!(reused.summary.body, user_body);
        assert_eq!(reused.summary.updated_at_ms, user_updated);
        assert_eq!(db.list_memory_sources("mem_user").unwrap().len(), 1);
        assert_eq!(db.list_memories(&MemoryQuery::default()).unwrap().len(), 1);

        let mut conflict = compaction_request("mem_agent", sample_turns());
        conflict.decisions = "决定新稿".into();
        let linked = ready(
            db.compact_session(MemoryActor::Agent, &conflict, 42)
                .unwrap(),
        );
        assert!(!linked.reused_existing);
        assert_eq!(linked.summary.author, MemoryAuthor::Agent);
        let link = linked
            .link
            .expect("new summary should point at the old one");
        assert_eq!(link.relation, MemoryRelation::Supersedes);
        assert_eq!(link.from_memory_id, "mem_agent");
        assert_eq!(link.to_memory_id, "mem_user");
        assert_eq!(db.load_memory("mem_user").unwrap().unwrap().body, user_body);
        assert!(matches!(
            db.revise_memory(
                MemoryActor::Agent,
                "mem_user",
                &MemoryRevision {
                    body: conflict_body(&conflict),
                    scope: conflict.scope.clone(),
                },
                43,
            ),
            Err(StorageError::OwnershipDenied { .. })
        ));

        let preference = db
            .write_memory(
                MemoryActor::User,
                &candidate(
                    "mem_pref",
                    preference("reply.language", "zh-CN"),
                    conflict.scope.clone(),
                    90,
                ),
                44,
            )
            .unwrap();
        assert!(matches!(preference, MemoryWriteOutcome::Stored { .. }));
        let mut contradicted = compaction_request("mem_contra", sample_turns());
        contradicted.decisions = "决定和偏好冲突".into();
        contradicted.conflict = Some(MemoryWriteConflict {
            target_memory_id: "mem_pref".into(),
            relation: MemoryRelation::Contradicts,
        });
        let contra = ready(
            db.compact_session(MemoryActor::Agent, &contradicted, 45)
                .unwrap(),
        );
        assert_eq!(
            contra.link.expect("contradiction link").relation,
            MemoryRelation::Contradicts
        );
        match db.load_memory("mem_pref").unwrap().unwrap().body {
            MemoryBody::Preference { value, .. } => assert_eq!(value, "zh-CN"),
            other => panic!("user preference changed: {other:?}"),
        }

        let mut graph = compaction_request("mem_graph", sample_turns());
        graph.decisions = "不该建立图关系".into();
        graph.conflict = Some(MemoryWriteConflict {
            target_memory_id: "mem_user".into(),
            relation: MemoryRelation::Associates,
        });
        assert!(matches!(
            db.compact_session(MemoryActor::Agent, &graph, 46),
            Err(StorageError::InvalidMemory(_))
        ));
        assert!(db.load_memory("mem_graph").unwrap().is_none());

        let mut overwrite = compaction_request("mem_user", sample_turns());
        overwrite.decisions = "试图覆盖用户摘要".into();
        assert!(matches!(
            db.compact_session(MemoryActor::Agent, &overwrite, 47),
            Err(StorageError::InvalidMemory(_))
        ));
        assert_eq!(db.load_memory("mem_user").unwrap().unwrap().body, user_body);

        let pack = db
            .load_memory_pack(&MemoryPackRequest {
                scope: recall(
                    "user_a",
                    Some("repo_a"),
                    Some("TextEdit"),
                    Some("task_1"),
                    None,
                ),
                stage: MemoryPackStage::Base,
                token_budget: 100_000,
                host_policy: "Host 策略".into(),
                query: String::new(),
                selected_memory_id: None,
            })
            .unwrap();
        let l0 = joined(&pack);
        assert!(l0.contains("决定新稿"));
        assert!(!l0.contains("决定旧稿"));
        assert!(
            render_body(&db.load_memory("mem_user").unwrap().unwrap().body).contains("决定旧稿")
        );
    }

    fn conflict_body(request: &SessionCompactionRequest) -> MemoryBody {
        let mut body = compaction_body(request);
        if let MemoryBody::CompactionSummary { decisions, .. } = &mut body {
            *decisions = "Agent 改写用户摘要".into();
        }
        body
    }

    #[test]
    fn persona_pack_keeps_facet_order_and_does_not_write() {
        let mut db = open();
        let fixture = seed_pack(&mut db);
        let before_memories = db.list_memories(&MemoryQuery::default()).unwrap().len();
        let before = db.load_personality("persona_main").unwrap().unwrap();
        let persona = db.load_compact_persona().unwrap().unwrap();
        assert_eq!(persona.personality_id, "persona_main");
        assert_eq!(persona.version, before.version);
        assert_eq!(persona.author, MemoryAuthor::User);
        assert_eq!(persona.mutability, MemoryMutability::UserReadonly);
        assert_eq!(
            persona.text,
            [
                "身份：Semi 助手",
                "语气：平静",
                "详略：简短",
                "语言：zh-CN",
                "主动：低",
                "行为：先确认外部副作用",
                "工具：只读默认可执行",
                "语音：不自动播报后台任务",
            ]
            .join("\n")
        );
        assert!(!persona.text.contains("演化备注不是事实"));
        assert!(!persona.text.contains("当前仓库是 Semi-OS"));

        db.create_personality(
            MemoryActor::User,
            "persona_idle",
            &PersonalityDraft {
                identity: "不该入选".into(),
                tone: "随意".into(),
                verbosity: "很长".into(),
                language: "en".into(),
                initiative: "高".into(),
                behavior_boundary: "不要装进运行时".into(),
                tool_policy: "不要装进运行时".into(),
                voice: "不要装进运行时".into(),
                evolution_note: Some("闲置演化".into()),
                active: false,
            },
            200,
        )
        .unwrap();
        db.write_memory(
            MemoryActor::Agent,
            &candidate(
                "pref_tone",
                preference("tone", "粗鲁嘲讽"),
                scope("user_a", Some("repo_a"), None, None, None),
                95,
            ),
            201,
        )
        .unwrap();
        let persona = db.load_compact_persona().unwrap().unwrap();
        assert_eq!(persona.tone, "平静");
        assert!(!persona.text.contains("粗鲁嘲讽"));
        assert!(!persona.text.contains("不该入选"));
        assert_eq!(
            db.load_personality("persona_main").unwrap().unwrap().tone,
            "平静"
        );
        assert_eq!(
            db.load_personality("persona_main")
                .unwrap()
                .unwrap()
                .version,
            before.version
        );

        let pack = db
            .load_memory_pack(&request(MemoryPackStage::Base, 100_000, "粗鲁", None))
            .unwrap();
        assert_order(&pack);
        assert_eq!(pack.stage, MemoryPackStage::Base);
        let persona_entry = pack
            .entries
            .iter()
            .find(|entry| entry.slot == MemoryPackSlot::CompactPersona)
            .unwrap();
        assert_eq!(persona_entry.text, persona.text);
        assert!(!persona_entry.text.contains("粗鲁嘲讽"));
        assert!(joined(&pack).contains("粗鲁嘲讽"));
        assert!(pack.entries.iter().all(|entry| {
            !matches!(
                entry.slot,
                MemoryPackSlot::L3 | MemoryPackSlot::L4 | MemoryPackSlot::L5
            )
        }));
        assert!(!joined(&pack).contains("情节摘要"));
        assert!(!joined(&pack).contains("完整流程候选"));
        assert_eq!(
            db.list_memories(&MemoryQuery::default()).unwrap().len(),
            before_memories + 1
        );
        assert_eq!(
            db.list_personality_versions("persona_main").unwrap().len(),
            1
        );
        let _ = fixture;

        let mut quiet = open();
        quiet
            .create_personality(
                MemoryActor::User,
                "persona_off",
                &PersonalityDraft {
                    identity: "关闭".into(),
                    tone: "平静".into(),
                    verbosity: "简短".into(),
                    language: "zh-CN".into(),
                    initiative: "低".into(),
                    behavior_boundary: "停用".into(),
                    tool_policy: "停用".into(),
                    voice: "停用".into(),
                    evolution_note: None,
                    active: false,
                },
                1,
            )
            .unwrap();
        assert!(quiet.load_compact_persona().unwrap().is_none());
        assert!(matches!(
            quiet.create_personality(
                MemoryActor::Agent,
                "persona_agent",
                &PersonalityDraft {
                    identity: "冒充".into(),
                    tone: "平静".into(),
                    verbosity: "简短".into(),
                    language: "zh-CN".into(),
                    initiative: "低".into(),
                    behavior_boundary: "不行".into(),
                    tool_policy: "不行".into(),
                    voice: "不行".into(),
                    evolution_note: None,
                    active: true,
                },
                2,
            ),
            Err(StorageError::OwnershipDenied { .. })
        ));
        assert!(quiet.load_compact_persona().unwrap().is_none());
    }
}
