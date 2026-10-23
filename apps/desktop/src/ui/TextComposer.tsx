import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { TEXT_INPUT_MAX_LENGTH } from "@semi-os/protocol";
import SlingButton from "./react-bits/SlingButton";
import VoicePill from "./react-bits/VoicePill";

/** 组件只提交用户意图；Host 转发给助手唯一控制器，不在此录音或播放。 */
export function TextComposer({
  disabled = false,
  voiceEnabled = false,
}: {
  disabled?: boolean;
  voiceEnabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [listening, setListening] = useState(false);
  const voiceQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const subscription = listen<unknown>("host://voice-input-state", ({ payload }) => {
      if (
        payload &&
        typeof payload === "object" &&
        "active" in payload &&
        typeof payload.active === "boolean"
      )
        setListening(payload.active);
    });
    return () => {
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  function controlVoice(action: "start" | "stop" | "cancel") {
    setListening(action === "start");
    setError("");
    // 仅串行交付意图，不等待录音/识别结束；快速按下松开也保持顺序。
    voiceQueue.current = voiceQueue.current.then(async () => {
      try {
        await invoke("control_voice_input", { action });
      } catch (cause) {
        setListening(false);
        setError(typeof cause === "string" ? cause : "语音操作失败，请检查助手是否就绪。");
      }
    });
  }

  async function send() {
    const text = draft.trim();
    if (!text || disabled || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await invoke("submit_text_message", { text });
      // 等待 Host 回执期间仍允许编辑；新草稿不得被旧提交清空。
      setDraft((current) => (current === draft ? "" : current));
      input.current?.focus();
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "消息发送失败，请检查助手是否就绪。");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="text-composer"
      aria-label="发送文字消息"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="text-composer-input">
        <textarea
          ref={input}
          aria-label="消息"
          placeholder="给 Semi-OS 发消息"
          rows={2}
          disabled={disabled}
          maxLength={TEXT_INPUT_MAX_LENGTH}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            // 中文输入法选词的 Enter 不能触发发送；Shift+Enter 保留换行。
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !composing.current &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-controls">
          <span className="composer-voice-slot" title="录制语音 · Command/Ctrl + Shift + Space">
            <VoicePill
              active={listening}
              disabled={disabled || !voiceEnabled}
              size={32}
              reactive="external"
              waveform={false}
              ariaLabel={listening ? "发送语音" : "录制语音"}
              onStart={() => controlVoice("start")}
              onStop={({ reason }) =>
                controlVoice(["tap", "release", "key"].includes(reason) ? "stop" : "cancel")
              }
            />
          </span>
          <SlingButton
            onSend={() => {
              void send();
            }}
            size={32}
            armAt={32}
            maxPull={100}
            flight={72}
            disabled={disabled || pending || !draft.trim()}
            ariaLabel={pending ? "正在发送" : "发送消息"}
          />
        </div>
      </div>
      {error && (
        <p className="research-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
