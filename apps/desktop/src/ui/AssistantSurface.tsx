import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type { AssistantMode, AssistantViewState } from "./client-model";
import { HaloScene } from "./HaloScene";

const assistantStates: Record<AssistantMode, AssistantViewState> = {
  idle: {
    status: "随时待命",
    title: "Semi-OS",
    detail: "按住快捷键开始说话",
  },
  listening: {
    status: "正在聆听",
    title: "我在听",
    detail: "帮我整理今天的会议纪要",
  },
  working: {
    status: "正在处理",
    title: "正在整理会议纪要",
    detail: "提取结论、负责人和待办事项",
  },
  waiting_confirmation: {
    status: "等待确认",
    title: "会议纪要已经整理完成",
    detail: "是否写入飞书 · 产品周会",
    confirmation: {
      action: "确认写入",
      target: "飞书 · 产品周会",
    },
  },
  paused: {
    status: "已暂停",
    title: "任务停在这里",
    detail: "再次发出指令即可继续",
  },
  cancelled: {
    status: "已取消",
    title: "任务已经取消",
    detail: "随时可以开始新的对话",
  },
};

function resolveInitialMode(): AssistantMode {
  const previewMode = new URLSearchParams(window.location.search).get("mode");
  return previewMode && previewMode in assistantStates
    ? (previewMode as AssistantMode)
    : "listening";
}

export function AssistantSurface() {
  const [mode, setMode] = useState<AssistantMode>(resolveInitialMode);
  const state = assistantStates[mode];
  const particleCount = useMemo(() => Array.from({ length: 18 }), []);

  useEffect(() => {
    const pressed = listen("host://push-to-talk-pressed", () => {
      setMode("listening");
    }).catch(() => undefined);
    const released = listen("host://push-to-talk-released", () => {
      setMode("working");
    }).catch(() => undefined);

    return () => {
      void pressed.then((unlisten) => unlisten?.());
      void released.then((unlisten) => unlisten?.());
    };
  }, []);

  return (
    <main
      className="assistant-shell"
      data-mode={mode}
      data-tauri-drag-region
      aria-label={`Semi-OS 助手，${state.status}`}
    >
      <div className="assistant-backdrop" aria-hidden="true" />
      <div className="assistant-particle-field" aria-hidden="true">
        {particleCount.map((_, particle) => (
          <i
            key={particle}
            style={{
              animationDelay: `${particle * -0.31}s`,
              left: `${(particle * 37) % 100}%`,
              top: `${(particle * 61) % 100}%`,
              width: `${1 + (particle % 3) * 0.55}px`,
              height: `${1 + (particle % 3) * 0.55}px`,
            }}
          />
        ))}
      </div>
      <div className="assistant-halo" aria-hidden="true">
        <HaloScene mode={mode} />
      </div>

      <section className="assistant-copy" aria-live="polite">
        <div className="assistant-core-copy">
          <span className="assistant-status">{state.status}</span>
          <h1>{state.title}</h1>
        </div>
        <p>{state.detail}</p>
      </section>

      {state.confirmation ? (
        <div className="assistant-confirmation">
          <span>{state.confirmation.target}</span>
          <button type="button" onClick={() => setMode("cancelled")}>
            暂不
          </button>
          <button
            className="is-primary"
            type="button"
            onClick={() => setMode("working")}
          >
            {state.confirmation.action}
          </button>
        </div>
      ) : null}
    </main>
  );
}
