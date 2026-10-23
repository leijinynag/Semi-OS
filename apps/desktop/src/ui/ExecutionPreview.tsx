import { useState } from "react";
import { ExecutionView, type ApprovalDecision } from "./TurnExecution";
import type { ExecutionSnapshot } from "./execution";
import { Markdown } from "./ConversationPanel";
import { TextComposer } from "./TextComposer";

// 仅由 DEV 显式路由载入的确定性样例，不注入生产会话、来源或 Host。
const research: ExecutionSnapshot = {
  taskId: "task_preview_research",
  lifecycle: "completed",
  approvals: [],
  progress: [
    { sequence: 1, callId: "open", toolName: "browser_open", label: "搜索资料" },
    { sequence: 2, callId: "read", toolName: "browser_extract", label: "阅读来源" },
  ],
  receipts: [
    {
      attemptId: "attempt_open",
      taskId: "task_preview_research",
      toolName: "browser_open",
      idempotencyKey: "task_preview_research:open",
      status: "succeeded",
      inputSummary: "https://tauri.app/",
      outputSummary: "已打开 Tauri 官方文档，页面标题与最终 URL 已读取。",
      durationMs: 820,
    },
    {
      attemptId: "attempt_read",
      taskId: "task_preview_research",
      toolName: "browser_extract",
      idempotencyKey: "task_preview_research:read",
      status: "succeeded",
      inputSummary: "提取官方架构说明",
      outputSummary: "已采集正文。页面采集成功不代表其中所有事实已核验。",
      durationMs: 430,
    },
  ],
  sources: [
    {
      sourceId: "source_tauri",
      taskId: "task_preview_research",
      title: "Tauri · Core Architecture",
      finalUrl: "https://tauri.app/concept/architecture/",
      status: "collected",
    },
    {
      sourceId: "source_pw",
      taskId: "task_preview_research",
      title: "Playwright · Browser Contexts",
      finalUrl: "https://playwright.dev/docs/browser-contexts",
      status: "collected",
    },
    {
      sourceId: "source_login",
      taskId: "task_preview_research",
      title: "社区讨论",
      finalUrl: "https://example.com/discussion",
      status: "needs_user",
      reason: "页面要求登录，未作为已读取的证据",
    },
  ],
};
const approval = {
  operationId: "preview_approval",
  value: {
    taskId: "task_preview_approval",
    toolName: "bash",
    riskLevel: "external_side_effect",
    inputJson: JSON.stringify(
      { command: "pnpm add @beui/agent-activity", cwd: "/workspace/demo" },
      null,
      2,
    ),
  },
};
const pending: ExecutionSnapshot = {
  taskId: "task_preview_approval",
  lifecycle: "waiting_confirmation",
  progress: [{ sequence: 1, callId: "install", toolName: "bash", label: "安装组件依赖" }],
  receipts: [],
  sources: [],
  approvals: [approval],
};
export default function ExecutionPreview() {
  const [decisions, setDecisions] = useState<ApprovalDecision[]>([]);
  return (
    <main className="client-stage">
      <section className="client-workbench" aria-label="Semi-OS 组件预览">
        <header className="client-topbar">
          <span className="client-wordmark">SemiOS</span>
          <span className="execution-preview-label">组件预览 · 示例数据</span>
        </header>
        <aside className="client-sidebar">
          <div className="client-session-list">
            <button className="client-session-item is-active">执行过程展示</button>
          </div>
        </aside>
        <div className="client-resize-handle" />
        <article className="client-conversation research-workbench">
          <section className="conversation-panel">
            <article className="conversation-turn">
              <div className="conversation-message conversation-message-user">
                <p>帮我看看桌面助手的技术架构，附上来源。</p>
              </div>
              <ExecutionView snapshot={research} onDecide={() => {}} />
              <div className="conversation-message conversation-message-agent">
                <Markdown>
                  {
                    "建议保持 **React → Rust Host → Node Worker → Pi** 的边界。\n\n- React 展示对话和执行过程。\n- Rust 负责权限、持久化和原生能力。\n- Node 承载 Pi 与浏览器工具。\n\n执行过程留在界面里，语音只汇报结论和需要你决定的操作。"
                  }
                </Markdown>
              </div>
            </article>
            <article className="conversation-turn">
              <div className="conversation-message conversation-message-user">
                <p>把这组组件装到项目里。</p>
              </div>
              <ExecutionView
                snapshot={{ ...pending, approvals: decisions.length ? [] : pending.approvals }}
                decisions={decisions}
                onDecide={(item, approved) => {
                  setDecisions([{ approval: item, status: approved ? "approved" : "denied" }]);
                }}
              />
            </article>
          </section>
        </article>
        <aside className="client-context">
          <span className="context-eyebrow">当前对话</span>
          <p>组件接入</p>
        </aside>
        <footer className="command-composer research-composer chat-composer">
          <TextComposer disabled voiceEnabled={false} />
        </footer>
      </section>
    </main>
  );
}
