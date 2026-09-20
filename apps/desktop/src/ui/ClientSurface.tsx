import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import {
  AgentIcon,
  ArrowIcon,
  CheckCircleIcon,
  DocumentIcon,
  ImageIcon,
  LinkIcon,
  SendIcon,
} from "./icons";

interface ArchiveItem {
  id: string;
  time: string;
  title: string;
  hint?: string;
}

interface ArchiveGroup {
  label: string;
  date?: string;
  items: readonly ArchiveItem[];
}

interface EvidenceItem {
  id: string;
  name: string;
  meta: string;
  kind: "document" | "image" | "link";
}

interface TodoItem {
  id: string;
  label: string;
  done: boolean;
}

const archiveGroups: readonly ArchiveGroup[] = [
  {
    label: "今天",
    date: "9月20日",
    items: [
      { id: "meeting", time: "14:32", title: "会议纪要", hint: "文档" },
      { id: "requirements", time: "09:12", title: "产品需求讨论" },
      { id: "feedback", time: "08:36", title: "用户反馈整理" },
    ],
  },
  {
    label: "昨天",
    items: [
      { id: "design-review", time: "19:48", title: "设计评审" },
      { id: "project-sync", time: "09:03", title: "项目进展同步" },
    ],
  },
  {
    label: "9月18日",
    items: [
      { id: "market", time: "16:20", title: "市场调研" },
      { id: "proposal", time: "10:17", title: "方案评审" },
    ],
  },
];

const evidenceItems: readonly EvidenceItem[] = [
  {
    id: "meeting-pdf",
    name: "产品会议纪要.pdf",
    meta: "今天 10:18",
    kind: "document",
  },
  {
    id: "meeting-photo",
    name: "会议现场照片.jpg",
    meta: "今天 10:16",
    kind: "image",
  },
  {
    id: "requirements-doc",
    name: "需求文档.docx",
    meta: "今天 09:52",
    kind: "document",
  },
  {
    id: "prototype-link",
    name: "产品原型链接",
    meta: "今天 09:37",
    kind: "link",
  },
];

const conclusions = [
  "产品核心能力方向与当前规划一致",
  "下阶段重点关注用户体验优化",
  "技术方案评估通过，按计划推进",
] as const;

const initialTodos: readonly TodoItem[] = [
  { id: "todo-requirements", label: "完善产品需求文档", done: false },
  { id: "todo-design", label: "与设计团队确认视觉方案", done: false },
  { id: "todo-schedule", label: "同步开发排期与资源", done: false },
];

async function setAssistantVisibility(visible: boolean) {
  // React 只提交显隐意图，真实窗口与权限状态仍由 Rust Host 统一管理。
  await invoke("set_assistant_visible", { visible });
}

function ArchiveTimeline({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="archive-timeline" aria-label="任务档案">
      {archiveGroups.map((group) => (
        <section className="archive-group" key={group.label}>
          <header>
            <strong>{group.label}</strong>
            {group.date ? <span>{group.date}</span> : null}
          </header>
          <div className="archive-items">
            {group.items.map((item) => (
              <button
                className={`archive-item${
                  item.id === selectedId ? " is-active" : ""
                }`}
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <span className="archive-time">{item.time}</span>
                <span className="archive-node" aria-hidden="true" />
                <span className="archive-title">
                  {item.title}
                  {item.hint ? <small>{item.hint}</small> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </aside>
  );
}

function MeetingWorkbench({
  written,
  todos,
  onToggleTodo,
}: {
  written: boolean;
  todos: readonly TodoItem[];
  onToggleTodo: (id: string) => void;
}) {
  return (
    <article className="meeting-workbench">
      <header className="document-heading">
        <span className="document-mark" aria-hidden="true">
          <DocumentIcon size={24} weight="duotone" />
        </span>
        <div>
          <h1>会议纪要</h1>
          <p>整理今天的产品会议，提取结论和待办。</p>
          <span className={`document-status${written ? " is-complete" : ""}`}>
            <i aria-hidden="true" />
            {written ? "已写入 · 已完成回读验证" : "已整理 · 等待确认"}
          </span>
        </div>
      </header>

      <section className="document-section">
        <h2>
          <CheckCircleIcon size={21} weight="fill" />
          会议结论
        </h2>
        <ul className="conclusion-list">
          {conclusions.map((conclusion) => (
            <li key={conclusion}>{conclusion}</li>
          ))}
        </ul>
      </section>

      <section className="document-section todo-section">
        <h2>
          <CheckCircleIcon size={21} weight="regular" />
          待办
        </h2>
        <div className="todo-list">
          {todos.map((todo) => (
            <label className={todo.done ? "is-done" : undefined} key={todo.id}>
              <input
                checked={todo.done}
                type="checkbox"
                onChange={() => onToggleTodo(todo.id)}
              />
              <span aria-hidden="true" />
              {todo.label}
            </label>
          ))}
        </div>
      </section>
    </article>
  );
}

function EvidenceInspector({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="evidence-inspector" aria-label="相关证据">
      <header>
        <h2>相关证据</h2>
        <span>{evidenceItems.length}</span>
      </header>
      <div className="evidence-items">
        {evidenceItems.map((item) => {
          const Icon =
            item.kind === "image"
              ? ImageIcon
              : item.kind === "link"
                ? LinkIcon
                : DocumentIcon;
          return (
            <button
              className={`evidence-item${
                selectedId === item.id ? " is-active" : ""
              }`}
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
            >
              <span className={`evidence-kind kind-${item.kind}`}>
                <Icon size={21} weight="duotone" />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.meta}</small>
              </span>
              <ArrowIcon size={16} weight="bold" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function ClientSurface() {
  const [assistantVisible, setAssistantVisible] = useState(false);
  const [selectedArchiveId, setSelectedArchiveId] = useState("meeting");
  const [selectedEvidenceId, setSelectedEvidenceId] =
    useState("meeting-photo");
  const [command, setCommand] = useState("写入飞书 · 产品周会");
  const [written, setWritten] = useState(false);
  const [todos, setTodos] = useState(() =>
    initialTodos.map((todo) => ({ ...todo })),
  );

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
        // 普通浏览器没有 Tauri IPC，视觉与交互预览仍保持可用。
      });

    return () => {
      active = false;
      void stopListening.then((unlisten) => unlisten?.());
    };
  }, []);

  async function toggleAssistant() {
    const nextVisible = !assistantVisible;
    setAssistantVisible(nextVisible);
    try {
      await setAssistantVisibility(nextVisible);
    } catch {
      // 浏览器预览只更新本地状态；Tauri 环境中的失败由 Host 负责上报。
    }
  }

  function toggleTodo(todoId: string) {
    setTodos((current) =>
      current.map((todo) =>
        todo.id === todoId ? { ...todo, done: !todo.done } : todo,
      ),
    );
  }

  function confirmWrite() {
    setWritten(true);
    setCommand("已写入飞书，并完成内容回读验证");
  }

  function updateGlassPerspective(event: ReactPointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - bounds.left) / bounds.width;
    const normalizedY = (event.clientY - bounds.top) / bounds.height;
    const x = Math.min(1, Math.max(0, normalizedX));
    const y = Math.min(1, Math.max(0, normalizedY));

    // 仅传递低成本的视觉变量，避免把高频指针位置放入 React 状态。
    event.currentTarget.style.setProperty("--glass-x", `${x * 100}%`);
    event.currentTarget.style.setProperty("--glass-y", `${y * 100}%`);
    event.currentTarget.style.setProperty(
      "--glass-shift-x",
      `${(x - 0.5) * 12}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-shift-y",
      `${(y - 0.5) * 9}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-refraction-x",
      `${(0.5 - x) * 4.08}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-refraction-y",
      `${(0.5 - y) * 3.06}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-panel-x",
      `${(x - 0.5) * 2.16}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-panel-y",
      `${(y - 0.5) * 1.62}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-composer-x",
      `${(x - 0.5) * 1.44}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-composer-y",
      `${(y - 0.5) * 1.08}px`,
    );
    event.currentTarget.style.setProperty(
      "--glass-rotate-x",
      `${(0.5 - y) * 0.44}deg`,
    );
    event.currentTarget.style.setProperty(
      "--glass-rotate-y",
      `${(x - 0.5) * 0.52}deg`,
    );
  }

  function resetGlassPerspective(event: ReactPointerEvent<HTMLElement>) {
    event.currentTarget.style.setProperty("--glass-x", "68%");
    event.currentTarget.style.setProperty("--glass-y", "16%");
    event.currentTarget.style.setProperty("--glass-shift-x", "0px");
    event.currentTarget.style.setProperty("--glass-shift-y", "0px");
    event.currentTarget.style.setProperty("--glass-refraction-x", "0px");
    event.currentTarget.style.setProperty("--glass-refraction-y", "0px");
    event.currentTarget.style.setProperty("--glass-panel-x", "0px");
    event.currentTarget.style.setProperty("--glass-panel-y", "0px");
    event.currentTarget.style.setProperty("--glass-composer-x", "0px");
    event.currentTarget.style.setProperty("--glass-composer-y", "0px");
    event.currentTarget.style.setProperty("--glass-rotate-x", "0deg");
    event.currentTarget.style.setProperty("--glass-rotate-y", "0deg");
  }

  return (
    <main
      className="client-stage"
      onPointerLeave={resetGlassPerspective}
      onPointerMove={updateGlassPerspective}
    >
      <section className="liquid-window" aria-label="Semi-OS 工作台">
        <span className="glass-refraction" aria-hidden="true" />
        <span className="glass-specular" aria-hidden="true" />

        <header className="window-chrome" data-tauri-drag-region>
          <div className="traffic-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <button
            className={`assistant-presence${
              assistantVisible ? " is-active" : ""
            }`}
            type="button"
            title={assistantVisible ? "隐藏桌面助手" : "唤起桌面助手"}
            aria-label={assistantVisible ? "隐藏桌面助手" : "唤起桌面助手"}
            aria-pressed={assistantVisible}
            onClick={toggleAssistant}
          >
            <AgentIcon size={18} weight="duotone" />
          </button>
        </header>

        <div className="workbench-grid">
          <ArchiveTimeline
            selectedId={selectedArchiveId}
            onSelect={setSelectedArchiveId}
          />
          <MeetingWorkbench
            written={written}
            todos={todos}
            onToggleTodo={toggleTodo}
          />
          <EvidenceInspector
            selectedId={selectedEvidenceId}
            onSelect={setSelectedEvidenceId}
          />
        </div>

        <form
          className={`command-composer${written ? " is-complete" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            confirmWrite();
          }}
        >
          <SendIcon size={19} weight="duotone" aria-hidden="true" />
          <input
            aria-label="任务指令"
            value={command}
            onChange={(event) => {
              setWritten(false);
              setCommand(event.target.value);
            }}
          />
          <button
            className="composer-secondary"
            type="button"
            onClick={() => setCommand("")}
          >
            暂不
          </button>
          <button className="composer-primary" type="submit">
            {written ? "已写入" : "确认写入"}
          </button>
        </form>
      </section>
    </main>
  );
}
