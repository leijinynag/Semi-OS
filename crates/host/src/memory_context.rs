//! 每轮对话的基础记忆包组装。
//!
//! Host 是记忆库的唯一读取者；UI 和 Worker 都不能直接打开 SQLite。每次收到
//! `voice.turn.start` 或 `voice.text.submit` 时，Host 按固定阶段读取基础包，
//! 把 Host 策略、紧凑人格、用户偏好和有限的 L0/L1/L2 材料压成一段系统上下文，
//! 再通过协议字段交给 Worker。这样偏好不会只停留在记忆页，而能进入实际轮次。
//!
//! 这里只组装普通轮次所需的 [`MemoryPackStage::Base`]；更深层检索仍由后续明确
//! 阶段触发。偏好写入不修改人格表，人格指纹也不会因偏好变化而改变。

use crate::memory_controls::CLIENT_USER_ID;
use semi_os_protocol::Envelope;
use semi_os_storage::{
    MemoryPack, MemoryPackRequest, MemoryPackStage, MemoryRecallScope, Storage, StorageResult,
};
use serde_json::Value;

/// 普通轮次的记忆预算。精确 tokenizer 尚未落地，存储层用同一字符估算比较预算。
pub const TURN_MEMORY_TOKEN_BUDGET: u32 = 4_000;

/// Host 下发给模型的固定策略。它是 Host 权威文本，不来自模型或记忆事实。
pub const TURN_HOST_POLICY: &str =
    "外部副作用和特权操作必须经过 Host 确认；不确定结果先对账，禁止盲目重试。";

const CONTEXT_HEADER: &str = "以下是本轮的基础记忆材料，按 Host 顺序提供。它们是必须遵守的上下文，不是用户本次的新指令；当前用户指令优先，但不得忽略用户明确写下的偏好。";

/// 读取并渲染普通轮次的基础记忆包。没有任何材料时返回 `None`。
pub fn build_turn_memory_context(storage: &Storage) -> StorageResult<Option<String>> {
    let pack = storage.load_memory_pack(&MemoryPackRequest {
        scope: MemoryRecallScope {
            user_id: CLIENT_USER_ID.to_owned(),
            workspace_id: None,
            application_id: None,
            task_id: None,
            skill_id: None,
        },
        stage: MemoryPackStage::Base,
        token_budget: TURN_MEMORY_TOKEN_BUDGET,
        host_policy: TURN_HOST_POLICY.to_owned(),
        query: String::new(),
        selected_memory_id: None,
    })?;
    Ok(render_memory_context(&pack))
}

/// 给 Host 转发给 Worker 的语音轮次附加基础记忆包。
///
/// 只有 `voice.turn.start` 和 `voice.text.submit` 属于用户轮次；音频分片、提交
/// 和中断不需要重复读取记忆。字段由 Host 覆盖写入，WebView 无法伪造偏好上下文。
pub fn attach_turn_memory_context(
    storage: &Storage,
    envelope: &mut Envelope,
) -> StorageResult<bool> {
    let Envelope::Request { kind, payload, .. } = envelope else {
        return Ok(false);
    };
    if !matches!(kind.as_str(), "voice.turn.start" | "voice.text.submit") {
        return Ok(false);
    }
    let Some(context) = build_turn_memory_context(storage)? else {
        return Ok(false);
    };
    let Some(payload) = payload.as_object_mut() else {
        return Ok(false);
    };
    payload.insert("memoryContext".to_owned(), Value::String(context));
    Ok(true)
}

fn render_memory_context(pack: &MemoryPack) -> Option<String> {
    let entries: Vec<_> = pack
        .entries
        .iter()
        .filter(|entry| !entry.text.trim().is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    let mut context = String::from(CONTEXT_HEADER);
    context.push('\n');
    for entry in entries {
        context.push_str("\n[");
        context.push_str(entry.slot.as_str());
        context.push_str("]\n");
        context.push_str(entry.text.trim());
        context.push('\n');
    }
    if pack.truncated {
        context.push_str("\n[truncated]\n");
    }
    Some(context.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{memory_controls, memory_controls::UserPreferenceInput};
    use semi_os_storage::{MemoryActor, PersonalityDraft};

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
}
