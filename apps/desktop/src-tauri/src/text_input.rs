use std::sync::mpsc::{self, Receiver, Sender};

/// 客户端只发送意图；助手确认接收后才清空草稿，避免窗口未就绪时静默丢消息。
#[derive(Default)]
pub struct TextInputRelay {
    ready: bool,
    pending: Option<(String, Sender<Result<(), String>>)>,
    session_change: Option<SessionChange>,
}

/// 删除目标由 Host 绑定在原始意图上，助手回执不能追加或替换删除对象。
#[derive(Clone)]
pub struct SessionChange {
    pub target: String,
    pub deleting: Option<String>,
}

pub fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.encode_utf16().count() > 64_000 {
        return Err("消息不能为空，且不能超过 64000 字符".into());
    }
    Ok(())
}

impl TextInputRelay {
    pub fn ensure_ready(&self) -> Result<(), String> {
        if self.ready {
            Ok(())
        } else {
            Err("助手尚未就绪，请稍后再试".into())
        }
    }

    pub fn ready(&mut self) {
        self.ready = true;
    }

    pub fn begin(&mut self, id: String) -> Result<Receiver<Result<(), String>>, String> {
        if !self.ready {
            return Err("助手尚未就绪，请稍后再发送".into());
        }
        if self.pending.is_some() {
            return Err("上一条消息仍在提交，请稍候".into());
        }
        let (sender, receiver) = mpsc::channel();
        self.pending = Some((id, sender));
        self.session_change = None;
        Ok(receiver)
    }

    pub fn bind_session_change(&mut self, id: &str, change: SessionChange) -> Result<(), String> {
        if !self.is_pending(id) {
            return Err("会话切换请求已过期".into());
        }
        self.session_change = Some(change);
        Ok(())
    }

    pub fn session_change(&self, id: &str, target: &str) -> Result<SessionChange, String> {
        if !self.is_pending(id) {
            return Err("会话切换请求已过期".into());
        }
        self.session_change
            .as_ref()
            .filter(|change| change.target == target)
            .cloned()
            .ok_or_else(|| "会话切换目标不匹配".into())
    }

    pub fn finish(&mut self, id: &str, accepted: bool) -> Result<(), String> {
        if self
            .pending
            .as_ref()
            .is_none_or(|(pending, _)| pending != id)
        {
            return Err("过期的文字提交回执".into());
        }
        if let Some((_, sender)) = self.pending.take() {
            self.session_change = None;
            let result = if accepted {
                Ok(())
            } else {
                Err("文字消息提交失败，请查看对话中的错误".into())
            };
            let _ = sender.send(result);
        }
        Ok(())
    }

    pub fn is_pending(&self, id: &str) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|(pending, _)| pending == id)
    }

    pub fn remove(&mut self, id: &str) {
        if self
            .pending
            .as_ref()
            .is_some_and(|(pending, _)| pending == id)
        {
            self.pending = None;
            self.session_change = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_text() {
        assert!(validate_text(" \n").is_err());
        assert!(validate_text(&"a".repeat(64_001)).is_err());
        assert!(validate_text(&"😀".repeat(32_001)).is_err());
        assert!(validate_text("请帮我查资料").is_ok());
    }

    #[test]
    fn relay_requires_readiness_and_correlated_ack() {
        let mut relay = TextInputRelay::default();
        assert!(relay.begin("a".into()).is_err());
        relay.ready();
        let reply = relay.begin("a".into()).unwrap();
        assert!(relay.begin("b".into()).is_err());
        assert!(relay.finish("b", true).is_err());
        relay.finish("a", true).unwrap();
        assert_eq!(reply.recv().unwrap(), Ok(()));
        let failed = relay.begin("b".into()).unwrap();
        relay.finish("b", false).unwrap();
        assert!(failed.recv().unwrap().is_err());
    }

    #[test]
    fn expired_switch_cannot_activate_or_clear_a_new_request() {
        let mut relay = TextInputRelay::default();
        relay.ready();
        let _expired = relay.begin("old".into()).unwrap();
        assert!(relay.is_pending("old"));
        relay.remove("old");
        let _current = relay.begin("new".into()).unwrap();
        assert!(!relay.is_pending("old"));
        relay.remove("old");
        assert!(relay.is_pending("new"));
        assert!(relay.finish("old", true).is_err());
        assert!(relay.is_pending("new"));
    }

    #[test]
    fn session_ack_is_bound_to_the_host_target_and_delete_intent() {
        let mut relay = TextInputRelay::default();
        relay.ready();
        let _reply = relay.begin("switch".into()).unwrap();
        assert!(relay.session_change("switch", "b").is_err());
        relay
            .bind_session_change(
                "switch",
                SessionChange {
                    target: "b".into(),
                    deleting: Some("a".into()),
                },
            )
            .unwrap();
        assert!(relay.session_change("switch", "a").is_err());
        assert_eq!(
            relay
                .session_change("switch", "b")
                .unwrap()
                .deleting
                .as_deref(),
            Some("a")
        );
        relay.remove("switch");
        let _next = relay.begin("text".into()).unwrap();
        assert!(relay.session_change("text", "b").is_err());
    }
}
