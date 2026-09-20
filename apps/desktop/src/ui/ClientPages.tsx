import { useState } from "react";
import {
  conversationFixture,
  memoryFixtures,
  settingsFixture,
  skillFixtures,
  taskFixtures,
} from "./client-fixtures";
import type {
  ClientPageId,
  ClientSettings,
  TaskTimelineModel,
} from "./client-model";
import {
  AgentIcon,
  CheckIcon,
  LockIcon,
  MemoryIcon,
  MicrophoneIcon,
  SearchIcon,
  SkillsIcon,
  UserIcon,
} from "./icons";
import { TaskTimeline } from "./TaskTimeline";

export const pageMetadata: Record<
  ClientPageId,
  { eyebrow: string; title: string; description: string }
> = {
  conversation: {
    eyebrow: "当前会话",
    title: "早上好，准备做点什么？",
    description: "语音、文本和任务进度会汇入同一个连续会话。",
  },
  tasks: {
    eyebrow: "任务中心",
    title: "执行过程清晰可见",
    description: "进度来自结构化事件，不从助手回复中猜测。",
  },
  memory: {
    eyebrow: "长期记忆",
    title: "知道什么，也知道从哪来",
    description: "用户内容与 Agent 整理的记忆保持明确边界。",
  },
  skills: {
    eyebrow: "内置能力",
    title: "按任务动态启用 Skills",
    description: "首版仅加载可信的内置能力和脚本。",
  },
  settings: {
    eyebrow: "偏好设置",
    title: "调整你的 Semi-OS",
    description: "人格、语音与确认策略由用户控制。",
  },
};

function ConversationPage() {
  return (
    <div className="conversation-layout">
      <section className="conversation-feed">
        <div className="session-heading">
          <span className="live-dot" />
          会话持续中
          <small>本地演示数据</small>
        </div>
        <div className="message-list">
          {conversationFixture.map((message) => (
            <article
              className={`message message-${message.author}`}
              key={message.id}
            >
              <span className="message-avatar">
                {message.author === "user" ? (
                  <UserIcon size={17} weight="bold" />
                ) : (
                  <AgentIcon size={17} weight="duotone" />
                )}
              </span>
              <div>
                <header>
                  <strong>{message.author === "user" ? "你" : "Semi-OS"}</strong>
                  <time>{message.time}</time>
                </header>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
        </div>
        <button className="voice-composer" type="button">
          <MicrophoneIcon size={18} weight="bold" />
          <span>按住说话</span>
          <kbd>⌘ ⇧ Space</kbd>
        </button>
      </section>

      <aside className="conversation-context">
        <span>正在处理</span>
        <strong>{taskFixtures[0].title}</strong>
        <p>{taskFixtures[0].currentAction}</p>
        <div className="compact-progress">
          <span style={{ width: "68%" }} />
        </div>
        <small>3 / 4 个里程碑</small>
      </aside>
    </div>
  );
}

function TaskPage() {
  const [selectedTaskId, setSelectedTaskId] = useState(taskFixtures[0].id);
  const selectedTask =
    taskFixtures.find((task) => task.id === selectedTaskId) ?? taskFixtures[0];

  return (
    <div className="task-layout">
      <aside className="task-list" aria-label="任务列表">
        <div className="section-toolbar">
          <strong>最近任务</strong>
          <span>{taskFixtures.length}</span>
        </div>
        {taskFixtures.map((task) => (
          <TaskListItem
            active={task.id === selectedTask.id}
            key={task.id}
            onSelect={setSelectedTaskId}
            task={task}
          />
        ))}
      </aside>
      <TaskTimeline task={selectedTask} />
    </div>
  );
}

function TaskListItem({
  active,
  onSelect,
  task,
}: {
  active: boolean;
  onSelect: (taskId: string) => void;
  task: TaskTimelineModel;
}) {
  return (
    <button
      className={`task-list-item${active ? " is-active" : ""}`}
      type="button"
      onClick={() => onSelect(task.id)}
    >
      <span className={`task-state-dot status-${task.status}`} />
      <span>
        <strong>{task.title}</strong>
        <small>{task.updatedAt}</small>
      </span>
    </button>
  );
}

function MemoryPage() {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleMemories = memoryFixtures.filter((memory) =>
    `${memory.title}${memory.content}${memory.layer}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  return (
    <div className="memory-page">
      <label className="search-field">
        <SearchIcon size={17} weight="regular" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索记忆"
        />
      </label>
      <div className="memory-legend">
        <span>
          <UserIcon size={15} weight="bold" /> 用户创建，只读
        </span>
        <span>
          <AgentIcon size={15} weight="duotone" /> Agent 创建，可整理
        </span>
      </div>
      <div className="memory-list">
        {visibleMemories.map((memory) => (
          <article className="memory-row" key={memory.id}>
            <span className={`memory-source source-${memory.source}`}>
              {memory.source === "user" ? (
                <LockIcon size={16} weight="bold" />
              ) : (
                <MemoryIcon size={16} weight="duotone" />
              )}
            </span>
            <div>
              <header>
                <strong>{memory.title}</strong>
                <span>{memory.layer}</span>
              </header>
              <p>{memory.content}</p>
              <small>{memory.updatedAt}</small>
            </div>
          </article>
        ))}
        {visibleMemories.length === 0 ? (
          <p className="empty-state">没有匹配的记忆。</p>
        ) : null}
      </div>
    </div>
  );
}

function SkillsPage() {
  return (
    <div className="skills-table">
      <header>
        <span>Skill</span>
        <span>类别</span>
        <span>工具</span>
        <span>状态</span>
      </header>
      {skillFixtures.map((skill) => (
        <article key={skill.id}>
          <div>
            <span className="skill-icon">
              <SkillsIcon size={17} weight="duotone" />
            </span>
            <span>
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
            </span>
          </div>
          <span>{skill.category}</span>
          <span>{skill.toolCount}</span>
          <span className={`availability availability-${skill.availability}`}>
            {skill.availability === "ready"
              ? "可用"
              : skill.availability === "permission_required"
                ? "需要权限"
                : "不可用"}
          </span>
        </article>
      ))}
    </div>
  );
}

function ToggleSetting({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

function SettingsPage() {
  const [settings, setSettings] = useState<ClientSettings>(settingsFixture);

  function updateSetting<Key extends keyof ClientSettings>(
    key: Key,
    value: ClientSettings[Key],
  ) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="settings-layout">
      <section className="settings-section">
        <header>
          <strong>人格</strong>
          <small>此内容由你维护，Agent 不能覆盖。</small>
        </header>
        <textarea
          value={settings.personality}
          onChange={(event) => updateSetting("personality", event.target.value)}
          aria-label="Agent 人格"
        />
      </section>
      <section className="settings-section">
        <header>
          <strong>语音与确认</strong>
          <small>这些设置将在接入 Host 后成为真实策略输入。</small>
        </header>
        <ToggleSetting
          checked={settings.voiceReply}
          label="默认语音播报"
          description="先响应，再从第一句完整句子开始播报。"
          onChange={(checked) => updateSetting("voiceReply", checked)}
        />
        <ToggleSetting
          checked={settings.floatingConfirmation}
          label="悬浮窗确认按钮"
          description="需要确认时显示批准与拒绝操作。"
          onChange={(checked) => updateSetting("floatingConfirmation", checked)}
        />
        <ToggleSetting
          checked={settings.confirmHighRisk}
          label="高风险操作必须确认"
          description="涉及系统权限或敏感目标时暂停执行。"
          onChange={(checked) => updateSetting("confirmHighRisk", checked)}
        />
        <ToggleSetting
          checked={settings.confirmExternalSideEffect}
          label="外部副作用必须确认"
          description="发送消息、提交表单等操作默认需要确认。"
          onChange={(checked) =>
            updateSetting("confirmExternalSideEffect", checked)
          }
        />
      </section>
      <div className="settings-saved">
        <CheckIcon size={16} weight="bold" />
        设置已保存在当前预览会话
      </div>
    </div>
  );
}

export function ClientPage({ page }: { page: ClientPageId }) {
  switch (page) {
    case "conversation":
      return <ConversationPage />;
    case "tasks":
      return <TaskPage />;
    case "memory":
      return <MemoryPage />;
    case "skills":
      return <SkillsPage />;
    case "settings":
      return <SettingsPage />;
  }
}
