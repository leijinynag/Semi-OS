import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { VoiceClient } from "./voice-client";

export const assistantVoice = new VoiceClient();

/** 只在助手 WebView 初始化一次；StrictMode/隐藏窗口不会创建第二个播放器。 */
export async function initializeAssistantVoice(): Promise<void> {
  await assistantVoice.connect();
  // 开始/停止本地门控不等待云端；快捷键只释放自己开启的录音。
  let owner: "shortcut" | "button" | undefined;
  const publish = () => {
    if (!assistantVoice.capturing) owner = undefined;
    void invoke("publish_voice_input_state", { active: assistantVoice.capturing }).catch(() => {});
  };
  const start = (source: "shortcut" | "button") => {
    if (!assistantVoice.capturing) owner = source;
    const operation = assistantVoice.start();
    publish();
    void operation.finally(publish).catch(() => {});
  };
  const finish = (cancel: boolean) => {
    const operation = cancel ? assistantVoice.cancelRecording() : assistantVoice.stop();
    publish();
    void operation.finally(publish).catch(() => {});
  };
  assistantVoice.subscribe(publish);
  await listen<{ id: string; text: string }>("host://text-input", ({ payload }) => {
    void assistantVoice
      .submitText(payload.text)
      .then(
        () => invoke("acknowledge_text_message", { id: payload.id, accepted: true }),
        () => invoke("acknowledge_text_message", { id: payload.id, accepted: false }),
      )
      .catch(() => {});
  });
  await listen<{ id: string; sessionId: string }>("host://session-input", ({ payload }) => {
    void assistantVoice
      .switchSession(payload.sessionId, payload.id)
      .then(
        () => invoke("acknowledge_text_message", { id: payload.id, accepted: true }),
        () => invoke("acknowledge_text_message", { id: payload.id, accepted: false }),
      )
      .catch(() => {});
  });
  await listen<{ action: string }>("host://voice-input", ({ payload }) => {
    if (payload.action === "start") start("button");
    else if (payload.action === "stop") finish(false);
    else if (payload.action === "cancel") finish(true);
  });
  await listen("host://push-to-talk-pressed", () => start("shortcut"));
  await listen("host://push-to-talk-released", () => {
    if (owner === "shortcut") finish(false);
  });
  // 所有输入监听就绪后再允许客户端提交，防止事件丢在初始化空窗里。
  await invoke("register_text_input_controller");
  window.addEventListener("beforeunload", () => assistantVoice.dispose(), { once: true });
}
