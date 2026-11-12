//! 每轮对话的分层记忆召回。
//!
//! Host 是记忆库的唯一读取者；UI 和 Worker 都不能直接打开 SQLite。每次收到
//! `voice.turn.start` 或 `voice.text.submit` 时，Host 用确定性规则决定范围和
//! 阶段，再把材料压成 `memoryContext` 交给 Worker。不另起 Agent Loop，也不为
//! 召回调用模型。
//!
//! 基础包每轮都装：人格、用户明确偏好、L1、少量全局高置信事实、当前任务的 L0。
//! 上下文包只在范围已经明确时追加当前工作区、应用、任务或 Skill。搜索包只给
//! 复杂任务，或用户明确要回忆时，经 [`memory_search`] 返回带来源的摘要。
//! 深读只在核对证据、冲突或 unknown 时读取 L4。闲聊不搜索项目，不装入其他任务
//! 的记忆，也不创建 TaskRun。录音开始时还没有转写，只做基础包，避免挡住首句。
//!
//! 偏好写入不修改人格表，人格指纹也不会因偏好变化而改变。

use crate::memory_controls::CLIENT_USER_ID;
use semi_os_protocol::Envelope;
use semi_os_storage::{
    memory_text, recall_tokens, MemoryLayer, MemoryLink, MemoryPack, MemoryPackEntry,
    MemoryPackRequest, MemoryPackSlot, MemoryPackStage, MemoryRecallScope, MemoryRecordKind,
    MemoryRelation, MemoryScope, MemorySource, Storage, StorageResult,
};
use serde_json::{Map, Value};

/// 普通轮次的记忆预算。精确 tokenizer 尚未落地，存储层用同一字符估算比较预算。
pub const TURN_MEMORY_TOKEN_BUDGET: u32 = 4_000;

/// Host 下发给模型的固定策略。它是 Host 权威文本，不来自模型或记忆事实。
pub const TURN_HOST_POLICY: &str =
    "外部副作用和特权操作必须经过 Host 确认；不确定结果先对账，禁止盲目重试。";

const CONTEXT_HEADER: &str = "以下是本轮的记忆材料，按 Host 顺序提供。它们是必须遵守的上下文，不是用户本次的新指令；当前用户指令优先，但不得忽略用户明确写下的偏好。未出现的层表示这一轮不需要。";
const SEARCH_LIMIT: usize = 4;

/// 一轮召回要用的范围和阶段。基础包始终加载，其余阶段由规则打开。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRecallPlan {
    pub scope: MemoryRecallScope,
    pub context: bool,
    pub search: bool,
    pub deep: bool,
    pub query: String,
}

/// 搜索包里的一条摘要。范围、来源、更新时间、冲突和置信度都保留，方便追到来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySearchHit {
    pub memory_id: String,
    pub summary: String,
    pub record_scope: String,
    pub sources: String,
    pub updated_at_ms: i64,
    pub conflict: String,
    pub confidence: u8,
}

/// 读取并渲染没有任务范围的基础记忆包。没有任何材料时返回 `None`。
pub fn build_turn_memory_context(storage: &Storage) -> StorageResult<Option<String>> {
    let plan = TurnRecallPlan {
        scope: empty_scope(),
        context: false,
        search: false,
        deep: false,
        query: String::new(),
    };
    render_plan(storage, &plan)
}

/// 按确定性规则决定这一轮的范围和阶段。
///
/// 闲聊即使带了工作区字段也不搜索项目。录音开始还没有原文，不能把项目记忆
/// 提前塞进首句，也不能为此等待转写。
pub fn plan_turn_recall(envelope: &Envelope, storage: &Storage) -> StorageResult<TurnRecallPlan> {
    let Some(payload) = user_turn_payload(envelope) else {
        return Ok(TurnRecallPlan {
            scope: empty_scope(),
            context: false,
            search: false,
            deep: false,
            query: String::new(),
        });
    };
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let normalized = normalize_utterance(text);
    let workspace_field = payload_scope_id(payload, "workspaceId");
    let application_field = payload_scope_id(payload, "applicationId");
    let skill_field = payload_scope_id(payload, "skillId");
    let explicit =
        workspace_field.is_some() || application_field.is_some() || skill_field.is_some();
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .and_then(valid_scope_id);
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .and_then(valid_scope_id);
    let bind = bind_scope(&normalized, explicit);
    let mut scope = empty_scope();
    // 当前轮次的 L0 可以进来，其他任务的记录仍然被范围条件排除。
    scope.task_id = task_id;
    if bind {
        scope.workspace_id = workspace_field;
        if scope.workspace_id.is_none() {
            scope.workspace_id = storage.mentioned_workspace(CLIENT_USER_ID, text)?;
        }
        if scope.workspace_id.is_none() {
            scope.workspace_id = cwd;
        }
        scope.application_id = application_field;
        scope.skill_id = skill_field;
    }
    let query = recall_tokens(text).join(" ");
    let context = bind && has_clear_scope_target(&scope);
    Ok(TurnRecallPlan {
        scope,
        context,
        search: bind && (wants_search(&normalized) || is_complex(&normalized)),
        deep: bind && wants_evidence(&normalized) && !query.is_empty(),
        query,
    })
}

/// 在当前范围内搜索记忆摘要。不创建 TaskRun，也不读取 L4 原文。
pub fn memory_search(
    storage: &Storage,
    scope: &MemoryRecallScope,
    query: &str,
    limit: usize,
) -> StorageResult<Vec<MemorySearchHit>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    // 先取存储层上限，再丢掉偏好和基础层。否则用户偏好会占满名额，项目经验进不了搜索包。
    let hits = storage.search_memories(scope, query, 12)?;
    let mut rendered = Vec::new();
    for hit in hits {
        if !matches!(
            hit.record.layer,
            MemoryLayer::L2 | MemoryLayer::L3 | MemoryLayer::L5
        ) || hit.record.record_kind == MemoryRecordKind::Preference
        {
            continue;
        }
        rendered.push(MemorySearchHit {
            memory_id: hit.record.memory_id.clone(),
            summary: memory_text(&hit.record.body),
            record_scope: scope_label(&hit.record.scope),
            sources: source_label(&hit.sources),
            updated_at_ms: hit.record.updated_at_ms,
            conflict: conflict_label(&hit.links),
            confidence: hit.confidence,
        });
        if rendered.len() == limit {
            break;
        }
    }
    Ok(rendered)
}

/// 给 Host 转发给 Worker 的语音轮次附加这一轮实际需要的记忆材料。
///
/// 只有 `voice.turn.start` 和 `voice.text.submit` 属于用户轮次；音频分片、提交
/// 和中断不需要重复读取记忆。字段由 Host 覆盖写入，WebView 无法伪造偏好上下文。
/// 召回失败会让这一轮失败，避免对话在缺少已保存偏好的情况下继续。
pub fn attach_turn_memory_context(
    storage: &Storage,
    envelope: &mut Envelope,
) -> StorageResult<bool> {
    let is_user_turn = matches!(
        envelope,
        Envelope::Request { kind, .. }
            if matches!(kind.as_str(), "voice.turn.start" | "voice.text.submit")
    );
    if !is_user_turn {
        return Ok(false);
    }
    // 先按不可变信封决定召回，再写入 memoryContext。不能在持有 payload 可变借用时重读信封。
    let plan = plan_turn_recall(envelope, storage)?;
    let Some(context) = render_plan(storage, &plan)? else {
        return Ok(false);
    };
    let Envelope::Request { payload, .. } = envelope else {
        return Ok(false);
    };
    let Some(payload) = payload.as_object_mut() else {
        return Ok(false);
    };
    payload.insert("memoryContext".to_owned(), Value::String(context));
    Ok(true)
}

fn render_plan(storage: &Storage, plan: &TurnRecallPlan) -> StorageResult<Option<String>> {
    let base = storage.load_memory_pack(&pack_request(&plan.scope, MemoryPackStage::Base, ""))?;
    let context = if plan.context {
        Some(storage.load_memory_pack(&pack_request(&plan.scope, MemoryPackStage::Context, ""))?)
    } else {
        None
    };
    let search = if plan.search {
        memory_search(storage, &plan.scope, &plan.query, SEARCH_LIMIT)?
    } else {
        Vec::new()
    };
    let deep = if plan.deep {
        Some(storage.load_memory_pack(&pack_request(
            &plan.scope,
            MemoryPackStage::DeepEvidence,
            &plan.query,
        ))?)
    } else {
        None
    };
    Ok(render_layers(
        &base,
        context.as_ref(),
        &plan.scope,
        &search,
        deep.as_ref(),
    ))
}

fn pack_request(
    scope: &MemoryRecallScope,
    stage: MemoryPackStage,
    query: &str,
) -> MemoryPackRequest {
    MemoryPackRequest {
        scope: scope.clone(),
        stage,
        token_budget: TURN_MEMORY_TOKEN_BUDGET,
        host_policy: TURN_HOST_POLICY.to_owned(),
        query: query.to_owned(),
        selected_memory_id: None,
    }
}

fn render_layers(
    base: &MemoryPack,
    context: Option<&MemoryPack>,
    scope: &MemoryRecallScope,
    search: &[MemorySearchHit],
    deep: Option<&MemoryPack>,
) -> Option<String> {
    let mut included = Vec::new();
    let mut text = String::from(CONTEXT_HEADER);
    text.push('\n');
    append_entries(&mut text, &mut included, base.entries.iter());
    if let Some(context) = context {
        let extra: Vec<_> = context
            .entries
            .iter()
            .filter(|entry| {
                matches!(entry.slot, MemoryPackSlot::L2 | MemoryPackSlot::L3)
                    && entry
                        .memory_id
                        .as_deref()
                        .is_some_and(|id| !included.iter().any(|seen| seen == id))
            })
            .collect();
        if !extra.is_empty() {
            text.push_str("\n[context]\n");
            append_entries(&mut text, &mut included, extra);
        }
    }
    if !search.is_empty() {
        text.push_str("\n[search]\n查询范围 ");
        text.push_str(&recall_scope_label(scope));
        text.push('\n');
        for hit in search {
            text.push_str("\n[");
            text.push_str(&hit.memory_id);
            text.push_str("]\n");
            text.push_str(hit.summary.trim());
            text.push_str("\n范围 ");
            text.push_str(&hit.record_scope);
            text.push_str("\n来源 ");
            text.push_str(&hit.sources);
            text.push_str("\n更新时间 ");
            text.push_str(&hit.updated_at_ms.to_string());
            text.push_str("\n冲突 ");
            text.push_str(&hit.conflict);
            text.push_str("\n置信度 ");
            text.push_str(&hit.confidence.to_string());
            text.push('\n');
        }
    }
    if let Some(deep) = deep {
        let evidence: Vec<_> = deep
            .entries
            .iter()
            .filter(|entry| entry.slot == MemoryPackSlot::L4)
            .collect();
        if !evidence.is_empty() {
            text.push_str("\n[deep]\n");
            append_entries(&mut text, &mut included, evidence);
        }
    }
    if base.truncated
        || context.is_some_and(|pack| pack.truncated)
        || deep.is_some_and(|pack| pack.truncated)
    {
        text.push_str("\n[truncated]\n");
    }
    let trimmed = text.trim();
    if trimmed == CONTEXT_HEADER {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn append_entries<'a>(
    text: &mut String,
    included: &mut Vec<String>,
    entries: impl IntoIterator<Item = &'a MemoryPackEntry>,
) {
    for entry in entries {
        if entry.text.trim().is_empty() {
            continue;
        }
        if let Some(memory_id) = &entry.memory_id {
            included.push(memory_id.clone());
        }
        text.push_str("\n[");
        text.push_str(entry.slot.as_str());
        text.push_str("]\n");
        text.push_str(entry.text.trim());
        text.push('\n');
    }
}

fn empty_scope() -> MemoryRecallScope {
    MemoryRecallScope {
        user_id: CLIENT_USER_ID.to_owned(),
        workspace_id: None,
        application_id: None,
        task_id: None,
        skill_id: None,
    }
}

fn user_turn_payload(envelope: &Envelope) -> Option<&Map<String, Value>> {
    let Envelope::Request { kind, payload, .. } = envelope else {
        return None;
    };
    if !matches!(kind.as_str(), "voice.turn.start" | "voice.text.submit") {
        return None;
    }
    payload.as_object()
}

fn payload_scope_id(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(valid_scope_id)
}

fn valid_scope_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 128
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        None
    } else {
        Some(value.to_owned())
    }
}

fn bind_scope(normalized: &str, explicit: bool) -> bool {
    if normalized.is_empty() {
        return false;
    }
    if is_greeting(normalized) && !has_scope_cue(normalized) {
        return false;
    }
    explicit
        || has_scope_cue(normalized)
        || is_complex(normalized)
        || wants_search(normalized)
        || wants_evidence(normalized)
}

fn has_clear_scope_target(scope: &MemoryRecallScope) -> bool {
    scope.workspace_id.is_some()
        || scope.application_id.is_some()
        || scope.task_id.is_some()
        || scope.skill_id.is_some()
}

fn normalize_utterance(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_ascii_punctuation() || "，。！？、；：…~～".contains(character)
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_greeting(normalized: &str) -> bool {
    const GREETINGS: &[&str] = &[
        "你好",
        "您好",
        "嗨",
        "哈喽",
        "在吗",
        "早上好",
        "晚上好",
        "早安",
        "晚安",
        "谢谢",
        "谢谢你",
        "多谢",
        "好的",
        "嗯",
        "哈哈",
        "你好呀",
        "你好啊",
        "hello",
        "hi",
        "hey",
        "good morning",
        "good evening",
        "good night",
        "thanks",
        "thank you",
        "how are you",
        "你好吗",
        "最近怎么样",
        "吃了吗",
        "讲个笑话",
        "今天天气怎么样",
        "天气怎么样",
        "你是谁",
    ];
    GREETINGS.contains(&normalized)
}

fn has_scope_cue(normalized: &str) -> bool {
    const CUES: &[&str] = &[
        "项目",
        "仓库",
        "工作区",
        "任务",
        "技能",
        "应用",
        "修复",
        "实现",
        "重构",
        "排查",
        "调研",
        "配置",
        "编译",
        "测试",
        "部署",
        "代码",
        "分支",
        "继续",
        "上次",
        "之前",
        "skill",
        "workspace",
        "repo",
        "implement",
        "refactor",
        "debug",
        "fix",
        "rustfmt",
    ];
    CUES.iter().any(|cue| normalized.contains(cue))
}

fn wants_search(normalized: &str) -> bool {
    const CUES: &[&str] = &[
        "回忆",
        "上次",
        "之前",
        "以前",
        "经验",
        "搜索记忆",
        "查记忆",
        "有没有做过",
        "recall",
        "what did we",
    ];
    CUES.iter().any(|cue| normalized.contains(cue))
}

fn wants_evidence(normalized: &str) -> bool {
    const CUES: &[&str] = &["证据", "原文", "历史记录", "依据", "unknown", "不确定结果"];
    CUES.iter().any(|cue| normalized.contains(cue))
}

fn is_complex(normalized: &str) -> bool {
    normalized.chars().count() >= 48
        || [
            "并且",
            "然后",
            "同时",
            "以及",
            "另外",
            "调研",
            "对比",
            "排查",
            "重构",
            "investigate",
            "compare",
        ]
        .iter()
        .any(|cue| normalized.contains(cue))
}

fn recall_scope_label(scope: &MemoryRecallScope) -> String {
    format!(
        "用户={} 工作区={} 应用={} 任务={} 技能={}",
        scope.user_id,
        label_id(scope.workspace_id.as_deref()),
        label_id(scope.application_id.as_deref()),
        label_id(scope.task_id.as_deref()),
        label_id(scope.skill_id.as_deref())
    )
}

fn scope_label(scope: &MemoryScope) -> String {
    format!(
        "用户={} 工作区={} 应用={} 任务={} 技能={}",
        label_id(scope.user_id.as_deref()),
        label_id(scope.workspace_id.as_deref()),
        label_id(scope.application_id.as_deref()),
        label_id(scope.task_id.as_deref()),
        label_id(scope.skill_id.as_deref())
    )
}

fn label_id(value: Option<&str>) -> &str {
    value.unwrap_or("-")
}

fn source_label(sources: &[MemorySource]) -> String {
    if sources.is_empty() {
        return "none".to_owned();
    }
    sources
        .iter()
        .map(|source| format!("{}:{}", source.kind.as_str(), source.source_ref))
        .collect::<Vec<_>>()
        .join(",")
}

fn conflict_label(links: &[MemoryLink]) -> String {
    let mut parts: Vec<_> = links
        .iter()
        .filter(|link| {
            matches!(
                link.relation,
                MemoryRelation::Supersedes | MemoryRelation::Contradicts
            )
        })
        .map(|link| format!("{}:{}", link.relation.as_str(), link.to_memory_id))
        .collect();
    if parts.is_empty() {
        return "none".to_owned();
    }
    parts.sort();
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{memory_controls, memory_controls::UserPreferenceInput};
    use semi_os_storage::{
        MemoryActor, MemoryBody, MemoryRelation, MemoryScope, MemorySourceKind,
        MemoryWriteCandidate, MemoryWriteConflict, NewMemory, NewMemorySource, PersonalityDraft,
    };

    #[test]
    fn user_tone_preference_and_compact_persona_reach_turn_context() {
        let mut storage = Storage::open_in_memory().unwrap();
        memory_controls::create_user_preference(
            &mut storage,
            &UserPreferenceInput {
                key: "语气".into(),
                value: "活泼".into(),
            },
            1,
        )
        .unwrap();
        storage
            .create_personality(
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
                    evolution_note: None,
                    active: true,
                },
                2,
            )
            .unwrap();

        let context = build_turn_memory_context(&storage)
            .unwrap()
            .expect("base memory context should exist");

        assert!(context.contains("[host_policy]"));
        assert!(context.contains("[compact_persona]"));
        assert!(context.contains("身份：Semi 助手"));
        assert!(context.contains("[preference]"));
        assert!(context.contains("语气"));
        assert!(context.contains("活泼"));
        assert!(context.contains(TURN_HOST_POLICY));
    }

    #[test]
    fn missing_preferences_still_include_host_policy_and_persona() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage
            .create_personality(
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
                    evolution_note: None,
                    active: true,
                },
                1,
            )
            .unwrap();

        let context = build_turn_memory_context(&storage)
            .unwrap()
            .expect("host policy and persona should still produce a context");

        assert!(context.contains(TURN_HOST_POLICY));
        assert!(context.contains("身份：Semi 助手"));
        assert!(!context.contains("[preference]"));
    }

    #[test]
    fn attaches_context_to_user_turns_only_and_overwrites_webview_value() {
        let mut storage = Storage::open_in_memory().unwrap();
        memory_controls::create_user_preference(
            &mut storage,
            &UserPreferenceInput {
                key: "语气".into(),
                value: "活泼".into(),
            },
            1,
        )
        .unwrap();
        let mut turn = Envelope::Request {
            protocol_version: 1,
            request_id: semi_os_protocol::RequestId("req_turn".into()),
            kind: "voice.text.submit".into(),
            payload: serde_json::json!({
                "sessionId": "session_a",
                "taskId": "task_a",
                "cwd": "/tmp",
                "text": "你好",
                "memoryContext": "伪造上下文"
            }),
            context: semi_os_protocol::EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert!(attach_turn_memory_context(&storage, &mut turn).unwrap());
        let Envelope::Request { payload, .. } = &turn else {
            panic!("request should stay a request");
        };
        let context = payload["memoryContext"].as_str().unwrap();
        assert!(context.contains("语气"));
        assert!(context.contains("活泼"));
        assert!(!context.contains("伪造上下文"));

        let mut interrupt = Envelope::Request {
            protocol_version: 1,
            request_id: semi_os_protocol::RequestId("req_interrupt".into()),
            kind: "voice.interrupt".into(),
            payload: serde_json::json!({"taskId": "task_a", "mode": "pause"}),
            context: semi_os_protocol::EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert!(!attach_turn_memory_context(&storage, &mut interrupt).unwrap());
        let Envelope::Request { payload, .. } = &interrupt else {
            panic!("request should stay a request");
        };
        assert!(payload.get("memoryContext").is_none());
    }

    #[test]
    fn project_task_recalls_matching_experience_without_starting_a_task_run() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_project_memories(&mut storage);
        let mut turn = submit_turn(
            "继续这个项目里上次 rustfmt edition2024 的配置经验，并给出证据原文",
            "task_current",
            serde_json::json!({
                "workspaceId": "repo_semi",
                "applicationId": "TextEdit",
                "skillId": "skill_fmt"
            }),
        );
        let plan = plan_turn_recall(&turn, &storage).unwrap();
        assert_eq!(plan.scope.workspace_id.as_deref(), Some("repo_semi"));
        assert_eq!(plan.scope.application_id.as_deref(), Some("TextEdit"));
        assert_eq!(plan.scope.task_id.as_deref(), Some("task_current"));
        assert_eq!(plan.scope.skill_id.as_deref(), Some("skill_fmt"));
        assert!(plan.context);
        assert!(plan.search);
        assert!(plan.deep);

        assert!(attach_turn_memory_context(&storage, &mut turn).unwrap());
        let context = context_of(&turn);
        assert!(context.contains("[preference]"));
        assert!(context.contains("语气"));
        assert!(context.contains("[context]"));
        assert!(context.contains("上次把 rustfmt 配成 edition2024"));
        assert!(context.contains("TextEdit 保存前先观察"));
        assert!(context.contains("skill_fmt 提交前检查 rustfmt"));
        assert!(context.contains("[search]"));
        assert!(context.contains(
            "查询范围 用户=local 工作区=repo_semi 应用=TextEdit 任务=task_current 技能=skill_fmt"
        ));
        assert!(context.contains("冲突 supersedes:fact_old"));
        assert!(context.contains("置信度 "));
        assert!(context.contains("来源 "));
        assert!(context.contains("[deep]"));
        assert!(context.contains("evidence:rustfmt-edition2024"));
        assert!(context.contains("当前任务的压缩摘要"));
        assert!(!context.contains("edition2018"));
        assert!(!context.contains("Safari 不用自动填充"));
        assert!(!context.contains("skill_other 的私有发布步骤"));
        assert!(!context.contains("无关任务的发布笔记"));
        assert!(storage.load_task("task_current").unwrap().is_none());
        assert!(storage.load_task("task_other").unwrap().is_none());
    }

    #[test]
    fn casual_chat_does_not_recall_project_or_unrelated_task_memory() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_project_memories(&mut storage);
        let mut turn = submit_turn(
            "你好",
            "task_chat",
            serde_json::json!({
                "workspaceId": "repo_semi",
                "applicationId": "TextEdit",
                "skillId": "skill_fmt",
                "cwd": "repo_semi"
            }),
        );
        let plan = plan_turn_recall(&turn, &storage).unwrap();
        assert!(plan.scope.workspace_id.is_none());
        assert!(plan.scope.application_id.is_none());
        assert!(plan.scope.skill_id.is_none());
        assert_eq!(plan.scope.task_id.as_deref(), Some("task_chat"));
        assert!(!plan.context);
        assert!(!plan.search);
        assert!(!plan.deep);

        assert!(attach_turn_memory_context(&storage, &mut turn).unwrap());
        let context = context_of(&turn);
        assert!(context.contains("语气"));
        assert!(context.contains("全局事实：回答保持简短"));
        assert!(!context.contains("[context]"));
        assert!(!context.contains("[search]"));
        assert!(!context.contains("[deep]"));
        assert!(!context.contains("rustfmt"));
        assert!(!context.contains("TextEdit"));
        assert!(!context.contains("skill_fmt"));
        assert!(!context.contains("无关任务的发布笔记"));
        assert!(!context.contains("当前任务的压缩摘要"));
        assert!(storage.load_task("task_chat").unwrap().is_none());
        assert!(storage.load_task("task_current").unwrap().is_none());
    }

    #[test]
    fn voice_turn_start_does_not_load_project_memory_before_transcript() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_project_memories(&mut storage);
        let mut turn = Envelope::Request {
            protocol_version: 1,
            request_id: semi_os_protocol::RequestId("req_voice".into()),
            kind: "voice.turn.start".into(),
            payload: serde_json::json!({
                "sessionId": "session_a",
                "taskId": "task_voice",
                "cwd": "repo_semi",
                "mimeType": "audio/pcm",
                "workspaceId": "repo_semi",
                "applicationId": "TextEdit",
                "skillId": "skill_fmt"
            }),
            context: semi_os_protocol::EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        let plan = plan_turn_recall(&turn, &storage).unwrap();
        assert!(plan.scope.workspace_id.is_none());
        assert!(!plan.search);
        assert!(!plan.context);
        assert!(attach_turn_memory_context(&storage, &mut turn).unwrap());
        let context = context_of(&turn);
        assert!(context.contains(TURN_HOST_POLICY));
        assert!(!context.contains("rustfmt"));
        assert!(!context.contains("[search]"));
        assert!(storage.load_task("task_voice").unwrap().is_none());
    }

    #[test]
    fn mentioned_project_object_binds_workspace_without_an_explicit_id() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_project_memories(&mut storage);
        let mut turn = submit_turn(
            "上次 rustfmt edition2024 怎么配的",
            "task_mention",
            serde_json::json!({"cwd": "other_dir"}),
        );
        let plan = plan_turn_recall(&turn, &storage).unwrap();
        assert_eq!(plan.scope.workspace_id.as_deref(), Some("repo_semi"));
        assert!(plan.context);
        assert!(plan.search);
        assert!(attach_turn_memory_context(&storage, &mut turn).unwrap());
        let context = context_of(&turn);
        assert!(context.contains("上次把 rustfmt 配成 edition2024"));
        assert!(!context.contains("无关任务的发布笔记"));
        assert!(!context.contains("Safari 不用自动填充"));
        assert!(storage.load_task("task_mention").unwrap().is_none());
    }

    fn submit_turn(text: &str, task_id: &str, extra: serde_json::Value) -> Envelope {
        let mut payload = serde_json::json!({
            "sessionId": "session_a",
            "taskId": task_id,
            "cwd": "repo_semi",
            "text": text
        });
        if let (Some(payload), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                payload.insert(key.clone(), value.clone());
            }
        }
        Envelope::Request {
            protocol_version: 1,
            request_id: semi_os_protocol::RequestId("req_scoped".into()),
            kind: "voice.text.submit".into(),
            payload,
            context: semi_os_protocol::EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        }
    }

    fn context_of(envelope: &Envelope) -> String {
        let Envelope::Request { payload, .. } = envelope else {
            panic!("request should stay a request");
        };
        payload["memoryContext"].as_str().unwrap().to_owned()
    }

    fn seed_project_memories(storage: &mut Storage) {
        memory_controls::create_user_preference(
            storage,
            &UserPreferenceInput {
                key: "语气".into(),
                value: "活泼".into(),
            },
            1,
        )
        .unwrap();
        storage
            .write_memory(
                MemoryActor::User,
                &fact(
                    "fact_global",
                    MemoryBody::ProjectFact {
                        fact: "全局事实：回答保持简短".into(),
                    },
                    MemoryScope {
                        user_id: Some("local".into()),
                        ..MemoryScope::default()
                    },
                    90,
                    None,
                ),
                2,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "fact_old",
                    MemoryBody::ProjectFact {
                        fact: "rustfmt 旧配置是 edition2018".into(),
                    },
                    project_scope(None, None, None),
                    80,
                    None,
                ),
                3,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::User,
                &fact(
                    "fact_new",
                    MemoryBody::ProjectFact {
                        fact: "rustfmt 当前配置是 edition2024".into(),
                    },
                    project_scope(None, None, None),
                    95,
                    Some(MemoryWriteConflict {
                        target_memory_id: "fact_old".into(),
                        relation: MemoryRelation::Supersedes,
                    }),
                ),
                4,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "episode_rustfmt",
                    MemoryBody::TaskSummary {
                        summary: "上次把 rustfmt 配成 edition2024".into(),
                    },
                    project_scope(None, None, None),
                    80,
                    None,
                ),
                5,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "habit_textedit",
                    MemoryBody::ApplicationHabit {
                        application: "TextEdit".into(),
                        habit: "TextEdit 保存前先观察".into(),
                    },
                    project_scope(Some("TextEdit"), None, None),
                    80,
                    None,
                ),
                6,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "habit_safari",
                    MemoryBody::ApplicationHabit {
                        application: "Safari".into(),
                        habit: "Safari 不用自动填充".into(),
                    },
                    project_scope(Some("Safari"), None, None),
                    80,
                    None,
                ),
                7,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "skill_fmt_fact",
                    MemoryBody::ProjectFact {
                        fact: "skill_fmt 提交前检查 rustfmt".into(),
                    },
                    project_scope(None, None, Some("skill_fmt")),
                    85,
                    None,
                ),
                8,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "skill_other_fact",
                    MemoryBody::ProjectFact {
                        fact: "skill_other 的私有发布步骤".into(),
                    },
                    project_scope(None, None, Some("skill_other")),
                    85,
                    None,
                ),
                9,
            )
            .unwrap();
        storage
            .write_memory(
                MemoryActor::Agent,
                &fact(
                    "episode_other",
                    MemoryBody::TaskSummary {
                        summary: "无关任务的发布笔记".into(),
                    },
                    project_scope(None, Some("task_other"), None),
                    80,
                    None,
                ),
                10,
            )
            .unwrap();
        storage
            .create_memory(
                MemoryActor::System,
                &NewMemory {
                    memory_id: "plan_current".into(),
                    body: MemoryBody::CurrentPlan {
                        objective: "当前任务的压缩摘要".into(),
                        next_step: "继续".into(),
                    },
                    scope: project_scope(None, Some("task_current"), None),
                    sources: vec![NewMemorySource {
                        source_id: "src_plan_current".into(),
                        kind: MemorySourceKind::Task,
                        source_ref: "task_current".into(),
                        note: None,
                    }],
                },
                11,
            )
            .unwrap();
        storage
            .create_memory(
                MemoryActor::System,
                &NewMemory {
                    memory_id: "evidence_rustfmt".into(),
                    body: MemoryBody::MessageEvidence {
                        reference: "evidence:rustfmt-edition2024".into(),
                        note: Some("配置证据".into()),
                    },
                    scope: project_scope(None, None, None),
                    sources: vec![NewMemorySource {
                        source_id: "src_evidence_rustfmt".into(),
                        kind: MemorySourceKind::Artifact,
                        source_ref: "artifact_rustfmt".into(),
                        note: None,
                    }],
                },
                12,
            )
            .unwrap();
    }

    fn project_scope(
        application: Option<&str>,
        task: Option<&str>,
        skill: Option<&str>,
    ) -> MemoryScope {
        MemoryScope {
            user_id: Some("local".into()),
            workspace_id: Some("repo_semi".into()),
            application_id: application.map(str::to_owned),
            task_id: task.map(str::to_owned),
            skill_id: skill.map(str::to_owned),
        }
    }

    fn fact(
        id: &str,
        body: MemoryBody,
        scope: MemoryScope,
        confidence: u8,
        conflict: Option<MemoryWriteConflict>,
    ) -> MemoryWriteCandidate {
        MemoryWriteCandidate {
            memory_id: id.into(),
            body,
            scope,
            sources: vec![NewMemorySource {
                source_id: format!("src_{id}"),
                kind: MemorySourceKind::ConversationTurn,
                source_ref: format!("turn_{id}"),
                note: None,
            }],
            confidence,
            importance: 60,
            conflict,
        }
    }
}
