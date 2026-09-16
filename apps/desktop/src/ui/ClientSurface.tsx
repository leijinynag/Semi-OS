import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AgentIcon,
  ConversationIcon,
  MemoryIcon,
  SettingsIcon,
  SkillsIcon,
  TaskIcon,
} from "./icons";
import { useEffect, useState } from "react";
//导航栏
const navigation = [
  { label: "对话", icon: ConversationIcon },
  { label: "任务", icon: TaskIcon },
  { label: "记忆", icon: MemoryIcon },
  { label: "Skills", icon: SkillsIcon },
  { label: "设置", icon: SettingsIcon },
];

//窗口控制函数
async function setAssistantVisibility(visible: boolean) {
  // React 只提交窗口意图，权限与真实窗口状态由 Rust Host 统一控制。
  await invoke("set_assistant_visible", { visible });
}

export function ClientSurface() {
  const [assistantVisible, setAssistantVisible] = useState(false);
  const [windowError, setWindowError] = useState<string>();

  useEffect(() => {
    let active = true;
    const stopListening = listen<boolean>(
      "host://assistant-visibility-changed",
      ({ payload }) => {
        if (active) {
          setAssistantVisible(payload);
        }
      },
    ).catch(() => undefined);

    void invoke<boolean>("get_assistant_visibility")
      .then((visible) => {
        if (active) {
          setAssistantVisible(visible);
        }
      })
      .catch(() => {
        // 浏览器预览没有 Tauri IPC，保留默认隐藏状态即可。
      });

    return () => {
      active = false;
      void stopListening.then((unlisten) => unlisten?.());
    };
  }, []);

  async function toggleAssistant() {
    try {
      const nextVisible = !assistantVisible;
      await setAssistantVisibility(nextVisible);
      setAssistantVisible(nextVisible);
      setWindowError(undefined);
    } catch {
      // 浏览器预览没有 Tauri window API，界面仍应可独立开发。
      setWindowError("请在 Tauri 开发模式中控制助手窗口");
    }
  }

  return (
    <main className="client-shell">
      <aside className="client-sidebar">
        <div className="brand">
          <span className="brand-mark">
            <AgentIcon size={20} weight="duotone" />
          </span>
          <div>
            <strong>Semi-OS</strong>
            <span>LOCAL AGENT</span>
          </div>
        </div>

        <nav aria-label="主导航">
          {navigation.map(({ label, icon: Icon }, index) => (
            <button
              className={index === 0 ? "is-active" : undefined}
              key={label}
              type="button"
            >
              <Icon size={18} weight={index === 0 ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="runtime-indicator">
          <span />
          桌面壳已就绪
        </div>
      </aside>

      <section className="client-content">
        <header>
          <div>
            <span className="eyebrow">当前会话</span>
            <h1>早上好，准备做点什么？</h1>
          </div>
          <button className="assistant-toggle" type="button" onClick={toggleAssistant}>
            {assistantVisible ? "隐藏助手窗口" : "显示助手窗口"}
          </button>
        </header>

        <div className="conversation-stage">
          <div className="stage-core" aria-hidden="true">
            <span />
          </div>
          <p>按住全局快捷键后，Semi-OS 会在这里展示对话和任务进度。</p>
          {windowError ? <small role="status">{windowError}</small> : null}
        </div>

        <footer>
          <span>没有正在执行的任务</span>
          <span>Host · Worker · Voice</span>
        </footer>
      </section>
    </main>
  );
}
