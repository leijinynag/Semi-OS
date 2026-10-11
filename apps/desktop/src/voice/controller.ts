import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { VoiceClient } from "./voice-client";

export const assistantVoice = new VoiceClient();

/** 只在助手 WebView 初始化一次；StrictMode/隐藏窗口不会创建第二个播放器。 */
export async function initializeAssistantVoice(): Promise<void> {
  await assistantVoice.connect();
  await listen<{ id: string; text: string }>("host://text-input", ({ payload }) => {
    void assistantVoice.submitText(payload.text).then(
      () => invoke("acknowledge_text_message", { id: payload.id, accepted: true }),
      () => invoke("acknowledge_text_message", { id: payload.id, accepted: false }),
    ).catch(() => {});
  });
  await listen<{ id: string; sessionId: string }>("host://session-input", ({ payload }) => {
    void assistantVoice.switchSession(payload.sessionId, payload.id).then(
      () => invoke("acknowledge_text_message", { id: payload.id, accepted: true }),
      () => invoke("acknowledge_text_message", { id: payload.id, accepted: false }),
    ).catch(() => {});
  });
  // 必须先安装监听再宣布就绪，否则客户端发送可能落在事件空窗内。
  await invoke("register_text_input_controller");
  await listen("host://push-to-talk-pressed", () => { void assistantVoice.start(); });
  await listen("host://push-to-talk-released", () => { void assistantVoice.stop(); });
  window.addEventListener("beforeunload", () => assistantVoice.dispose(), { once: true });
}
