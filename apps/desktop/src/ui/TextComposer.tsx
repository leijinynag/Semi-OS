import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { TEXT_INPUT_MAX_LENGTH } from "@semi-os/protocol";
import { SendIcon } from "./icons";

/** 组件只提交用户意图；Host 转发给助手唯一控制器，不在此录音或播放。 */
export function TextComposer({ disabled = false }: { disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const text = draft.trim();
    if (!text || disabled || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await invoke("submit_text_message", { text });
      // 等待 Host 回执期间仍允许编辑；新草稿不得被旧提交清空。
      setDraft((current) => current === draft ? "" : current);
      input.current?.focus();
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "消息发送失败，请检查助手是否就绪。");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <form className="text-composer" aria-label="发送文字消息" onSubmit={(event) => {
    event.preventDefault();
    void send();
  }}>
    <div className="text-composer-input">
      <textarea ref={input} aria-label="消息" placeholder="给 Semi-OS 发消息" rows={2} disabled={disabled}
        maxLength={TEXT_INPUT_MAX_LENGTH} value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          // 中文输入法选词的 Enter 不能触发发送；Shift+Enter 保留换行。
          if (event.key === "Enter" && !event.shiftKey && !composing.current &&
            !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <button className="text-send" type="submit" title={pending ? "正在发送" : "发送消息"}
        aria-label={pending ? "正在发送" : "发送消息"} disabled={disabled || pending || !draft.trim()} aria-busy={pending}>
        <SendIcon size={20} weight="bold" />
      </button>
    </div>
    {error && <p className="research-error" role="alert">{error}</p>}
  </form>;
}
