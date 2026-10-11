use serde::{Deserialize, Serialize};

/// 当前轮次快照与最终回答分离。播放器仅广播进度，Worker 提供持久化文本。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conversation {
    pub request_id: String,
    pub session_id: String,
    pub task_id: String,
    pub state: String,
    pub transcript: String,
    pub assistant_text: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub report: String,
    pub error: Option<String>,
    pub playback: Option<Playback>,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playback {
    pub sentence_id: String,
    pub state: String,
    pub position_ms: u64,
}

impl Conversation {
    /// 页面重载只能替换录音轮次，不能替换仍由 Worker 持有的 Pi 会话。
    /// Host 存活期间保留首个 session_id；新窗口提供的 ID 仅用于首次初始化。
    pub fn start_turn(
        previous: Option<&Self>,
        request_id: String,
        proposed_session_id: String,
        task_id: String,
    ) -> Result<Self, String> {
        let value = Self {
            request_id,
            session_id: previous
                .map(|conversation| conversation.session_id.clone())
                .unwrap_or(proposed_session_id),
            task_id,
            state: "listening".into(),
            transcript: String::new(),
            assistant_text: String::new(),
            summary: String::new(),
            report: String::new(),
            error: None,
            playback: None,
            revision: 0,
        };
        value.validate()?;
        Ok(value)
    }

    /// 恢复副本展示完整文字；旧进程的播放位置不能恢复为正在播放。
    pub fn saved(&self) -> Self {
        let mut saved = self.clone();
        saved.assistant_text = saved.summary.clone();
        saved.state = if saved.error.is_some() {
            "error"
        } else {
            "idle"
        }
        .into();
        saved.playback = None;
        saved
    }

    pub fn validate(&self) -> Result<(), String> {
        for id in [&self.request_id, &self.session_id, &self.task_id] {
            if id.is_empty() || id.len() > 160 {
                return Err("invalid conversation identity".into());
            }
        }
        if ![
            "idle",
            "listening",
            "transcribing",
            "thinking",
            "speaking",
            "interrupted",
            "error",
        ]
        .contains(&self.state.as_str())
            // 与 JS 输入协议统一按 UTF-16 单元计数，避免中文通过提交却无法保存。
            || self.transcript.encode_utf16().count() > 64_000
            || self.assistant_text.len() > 128_000
            || self.report.len() > 512_000
            || self.summary.len() > 128_000
            || self.error.as_ref().is_some_and(|error| error.len() > 8192)
        {
            return Err("invalid conversation payload".into());
        }
        if let Some(playback) = &self.playback {
            if playback.sentence_id.len() > 160
                || playback.sentence_id.is_empty()
                || playback.position_ms > 600_000
                || !["playing", "buffering", "paused", "ended", "failed"]
                    .contains(&playback.state.as_str())
            {
                return Err("invalid playback payload".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_reload_keeps_session_but_resets_turn_and_error() {
        let mut previous = Conversation::start_turn(
            None,
            "req_first".into(),
            "session_original".into(),
            "task_first".into(),
        )
        .unwrap();
        previous.error = Some("previous failure".into());
        previous.transcript = "previous transcript".into();
        previous.summary = "previous answer".into();
        let next = Conversation::start_turn(
            Some(&previous),
            "req_reloaded".into(),
            "session_from_reloaded_page".into(),
            "task_reloaded".into(),
        )
        .unwrap();
        assert_eq!(next.session_id, "session_original");
        assert_eq!(next.request_id, "req_reloaded");
        assert_eq!(next.task_id, "task_reloaded");
        assert_eq!(next.state, "listening");
        assert!(next.error.is_none());
        assert!(next.transcript.is_empty());
        assert!(next.summary.is_empty());
        assert_eq!(next.revision, 0);
    }

    #[test]
    fn rejects_invalid_playback_identity_and_state() {
        let mut value: Conversation = serde_json::from_value(serde_json::json!({
            "requestId":"req_test", "sessionId":"session_test", "taskId":"task_test",
            "state":"speaking", "transcript":"你好", "assistantText":"你好",
            "playback":{"sentenceId":"s1","state":"playing","positionMs":200}
        }))
        .unwrap();
        assert!(value.validate().is_ok());
        value.playback.as_mut().unwrap().position_ms = 600_001;
        assert!(value.validate().is_err());
        value.playback = None;
        value.state = "pretend_finished".into();
        assert!(value.validate().is_err());
    }

    #[test]
    fn transcript_limit_matches_unicode_text_input() {
        let mut value =
            Conversation::start_turn(None, "req".into(), "session".into(), "task".into()).unwrap();
        value.transcript = "中".repeat(64_000);
        assert!(value.validate().is_ok());
        value.transcript.push('中');
        assert!(value.validate().is_err());
        value.transcript = "😀".repeat(32_000);
        assert!(value.validate().is_ok());
        value.transcript.push('😀');
        assert!(value.validate().is_err());
    }

    #[test]
    fn restores_full_text_and_failure_without_resuming_audio() {
        let value: Conversation = serde_json::from_value(serde_json::json!({
            "requestId":"req_test", "sessionId":"session_test", "taskId":"task_test",
            "state":"speaking", "transcript":"你好", "assistantText":"一",
            "summary":"一句完整回答。", "report":"## 报告", "error":"播放失败",
            "playback":{"sentenceId":"s1","state":"failed","positionMs":200}
        }))
        .unwrap();
        let saved = value.saved();
        assert_eq!(saved.state, "error");
        assert_eq!(saved.assistant_text, "一句完整回答。");
        assert_eq!(saved.report, value.report);
        assert_eq!(saved.error, value.error);
        assert!(saved.playback.is_none());
    }
}
