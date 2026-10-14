use crate::conversation::Conversation;
use serde_json::Value;

/// 语音事件应用后的副作用提示。
///
/// Conversation 的字段更新必须在 Host 核心完成，Tauri 入口只负责把已经
/// 校验过的快照持久化并广播。这样迟到事件、跨轮次事件和畸形 payload
/// 不会直接修改桌面状态。
#[derive(Debug, Clone)]
pub struct VoiceEventUpdate {
    pub conversation: Conversation,
    pub persist: bool,
    pub refresh_sessions: bool,
}

/// 将一个 Worker 语音事件应用到当前轮次。
///
/// `None` 表示事件与当前轮次无关，例如旧 requestId 或非语音事件；这不是
/// 错误，调用方应安静忽略。返回 `Err` 才表示事件声明了当前轮次身份但
/// payload 不符合语音契约，不能让它污染可恢复快照。
pub fn apply_voice_event(
    previous: &Conversation,
    request_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<Option<VoiceEventUpdate>, String> {
    if ![
        "voice.transcript.partial",
        "voice.transcript.final",
        "voice.answer",
        "voice.error",
        "voice.turn.completed",
        "voice.state",
    ]
    .contains(&kind)
    {
        return Ok(None);
    }
    if previous.request_id != request_id {
        return Ok(None);
    }
    if payload
        .get("sessionId")
        .is_some_and(|id| id != &Value::String(previous.session_id.clone()))
        || payload
            .get("taskId")
            .is_some_and(|id| id != &Value::String(previous.task_id.clone()))
    {
        return Err("voice identity mismatch".into());
    }

    let mut current = previous.clone();
    match kind {
        "voice.transcript.partial" | "voice.transcript.final" => {
            current.transcript = payload["text"].as_str().ok_or("invalid transcript")?.into();
        }
        "voice.answer" => {
            current.summary = payload["summary"].as_str().ok_or("invalid summary")?.into();
            current.report = payload["report"].as_str().ok_or("invalid report")?.into();
        }
        "voice.error" => {
            current.state = "error".into();
            current.error = Some(
                payload["message"]
                    .as_str()
                    .ok_or("invalid voice error")?
                    .into(),
            );
        }
        "voice.state" if payload["state"] != "idle" && current.error.is_none() => {
            // 合成结束不能把仍在播放的快照置为 idle；idle 由播放器本地状态控制。
            current.state = payload["state"].as_str().ok_or("invalid state")?.into();
        }
        _ => {}
    }
    current.validate()?;
    Ok(Some(VoiceEventUpdate {
        conversation: current,
        persist: matches!(
            kind,
            "voice.transcript.final" | "voice.answer" | "voice.error" | "voice.turn.completed"
        ),
        refresh_sessions: kind == "voice.transcript.final",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation() -> Conversation {
        Conversation::start_turn(
            None,
            "req_voice".into(),
            "session_voice".into(),
            "task_voice".into(),
        )
        .expect("fixture conversation")
    }

    #[test]
    fn ignores_old_or_non_voice_events_without_mutating_state() {
        let value = conversation();
        assert!(apply_voice_event(
            &value,
            "req_old",
            "voice.answer",
            &serde_json::json!({"summary": "old", "report": ""}),
        )
        .expect("stale events are ignored")
        .is_none());
        assert!(apply_voice_event(
            &value,
            "req_voice",
            "research.progress",
            &serde_json::json!({}),
        )
        .expect("other domains are ignored")
        .is_none());
    }

    #[test]
    fn rejects_cross_session_events_before_replacing_snapshot() {
        let value = conversation();
        let error = apply_voice_event(
            &value,
            "req_voice",
            "voice.transcript.final",
            &serde_json::json!({
                "sessionId": "session_other",
                "taskId": "task_voice",
                "text": "越界",
            }),
        )
        .expect_err("identity must be bound to the active turn");
        assert_eq!(error, "voice identity mismatch");
    }

    #[test]
    fn validates_payload_and_marks_persistent_boundaries() {
        let value = conversation();
        let partial = apply_voice_event(
            &value,
            "req_voice",
            "voice.transcript.partial",
            &serde_json::json!({"text": "临时"}),
        )
        .expect("partial transcript")
        .expect("active event");
        assert_eq!(partial.conversation.transcript, "临时");
        assert!(!partial.persist);
        assert!(!partial.refresh_sessions);

        let final_text = apply_voice_event(
            &partial.conversation,
            "req_voice",
            "voice.transcript.final",
            &serde_json::json!({"text": "最终"}),
        )
        .expect("final transcript")
        .expect("active event");
        assert!(final_text.persist);
        assert!(final_text.refresh_sessions);

        assert!(apply_voice_event(
            &value,
            "req_voice",
            "voice.answer",
            &serde_json::json!({"summary": "缺少报告"}),
        )
        .is_err());
    }

    #[test]
    fn keeps_error_state_when_late_idle_arrives() {
        let value = conversation();
        let failed = apply_voice_event(
            &value,
            "req_voice",
            "voice.error",
            &serde_json::json!({"message": "播放失败"}),
        )
        .expect("error event")
        .expect("active event");
        let idle = apply_voice_event(
            &failed.conversation,
            "req_voice",
            "voice.state",
            &serde_json::json!({"state": "idle"}),
        )
        .expect("late idle is valid")
        .expect("active event");
        assert_eq!(idle.conversation.state, "error");
        assert_eq!(idle.conversation.error.as_deref(), Some("播放失败"));
    }
}
