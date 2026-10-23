import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseWorkflowSnapshot } from "@semi-os/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion } from "motion/react";
import {
  AgentIcon,
  CollapseLeftIcon,
  DismissIcon,
  LinkIcon,
  NewSessionIcon,
  PanelIcon,
  SettingsIcon,
} from "./icons";
import { ConversationPanel, Markdown } from "./ConversationPanel";
import { TextComposer } from "./TextComposer";
import type { VoiceSettings } from "../voice/voice-client";
import { parseClientSessions, type ClientSession } from "./client-sessions";
import {
  SessionContextMenu,
  SessionDialogView,
  type SessionDialog,
  type SessionMenuPosition,
} from "./SessionControls";
import { useWorkflows, WorkflowPanel } from "./WorkflowPanel";

interface Source {
  sourceId: string;
  taskId: string;
  title: string;
  finalUrl: string;
  status: "collected" | "needs_user" | "failed";
  reason?: string;
  artifactId?: string;
  quotes: Array<{ quoteId: string; text: string }>;
}
interface Report {
  taskId: string;
  summary: string;
  claims: Array<{ text: string; citations: Array<{ sourceId: string; quoteId: string }> }>;
  limitations: string[];
}
interface ResearchTask {
  id: string;
  label: string;
  steps: string[];
  sources: Source[];
  report?: Report;
}
interface WorkerMessage {
  direction: string;
  kind: string;
  payload: Record<string, unknown>;
}

function statusFor(
  workflow: ReturnType<typeof useWorkflows>["workflows"][number] | undefined,
  confirmation: boolean,
): { label: string; tone: "idle" | "active" | "attention" | "complete"; detail: string } {
  if (confirmation)
    return { label: "需要确认", tone: "attention", detail: "有一个外部操作等待你的决定" };
  if (!workflow) return { label: "准备就绪", tone: "idle", detail: "等待新的任务" };
  if (workflow.status === "awaiting_approval")
    return { label: "待批准", tone: "attention", detail: "计划已经生成，等待你的确认" };
  if (workflow.background?.coordinator.executionStatus === "needs_user")
    return {
      label: "待处理",
      tone: "attention",
      detail: workflow.background.coordinator.reason ?? "需要你的输入",
    };
  if (workflow.runs.some((run) => run.status === "running"))
    return {
      label: "执行中",
      tone: "active",
      detail: `${workflow.runs.filter((run) => run.status === "running").length} 个执行单元正在工作`,
    };
  if (workflow.runs.some((run) => run.status === "failed"))
    return { label: "有失败", tone: "attention", detail: "部分执行单元需要检查" };
  if (
    workflow.status === "cancelled" ||
    workflow.status === "rejected" ||
    workflow.status === "paused"
  )
    return { label: "已暂停", tone: "idle", detail: "任务没有继续执行" };
  if (
    workflow.status === "approved" &&
    workflow.runs.length > 0 &&
    workflow.runs.every((run) => ["completed", "cancelled"].includes(run.status))
  )
    return { label: "已完成", tone: "complete", detail: "任务执行结果已经返回" };
  return { label: "准备中", tone: "active", detail: "正在准备任务上下文" };
}

/** Dynamic Island 只消费 Host 的结构化快照，视觉状态不参与任务语义判断。 */
function AgentStatusIsland({
  workflow,
  current,
  confirmation,
  onOpenDetails,
}: {
  workflow: ReturnType<typeof useWorkflows>["workflows"][number] | undefined;
  current: ResearchTask | undefined;
  confirmation: boolean;
  onOpenDetails: () => void;
}) {
  const status = statusFor(workflow, confirmation);
  const title = workflow?.plan.title ?? current?.label ?? "Semi-OS";
  const sourceCount = current?.sources.length ?? 0;
  const detail =
    status.tone === "active" && current?.steps.at(-1) ? current.steps.at(-1) : status.detail;

  return (
    <motion.button
      type="button"
      className={`status-island is-${status.tone}`}
      layout
      transition={{ layout: { type: "spring", stiffness: 420, damping: 34 } }}
      onClick={onOpenDetails}
      aria-label={`打开任务详情：${title}`}
    >
      <span className="status-island-mark" aria-hidden="true">
        <motion.span
          className="status-island-core"
          animate={
            status.tone === "active"
              ? { scale: [1, 1.22, 1], opacity: [0.72, 1, 0.72] }
              : { scale: 1, opacity: 0.9 }
          }
          transition={
            status.tone === "active"
              ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />
      </span>
      <span className="status-island-copy">
        <span className="status-island-title">{title}</span>
        <span className="status-island-detail">{detail}</span>
      </span>
      <span className="status-island-meta">
        <span className="status-island-label">{status.label}</span>
        {sourceCount > 0 && <span className="status-island-count">{sourceCount} 来源</span>}
      </span>
    </motion.button>
  );
}

/** 工作台展示 Host 已持久化的来源和结构化事件，不把模型散文解析成成功状态。 */
export function ResearchWorkbench() {
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [sessions, setSessions] = useState<ClientSession[]>([]);
  const [changingSession, setChangingSession] = useState(false);
  const changingSessionRef = useRef(false);
  const [sessionDialog, setSessionDialog] = useState<SessionDialog>();
  const [sessionMenu, setSessionMenu] = useState<SessionMenuPosition>();
  const closeSessionMenu = useCallback(() => setSessionMenu(undefined), []);
  const activeSessionId = sessions.find((session) => session.active)?.sessionId ?? "";
  const { workflows, error: workflowError } = useWorkflows(activeSessionId);
  const workflow = workflows[0];
  const [selected, setSelected] = useState("");
  const [artifact, setArtifact] = useState<{ title: string; text: string }>();
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>();
  const [savingVoice, setSavingVoice] = useState(false);
  const savingVoiceRef = useRef(false);
  const [confirmations, setConfirmations] = useState<
    Array<{ operationId: string; value: { toolName: string; inputJson: string } }>
  >([]);
  const confirmation = confirmations[0];
  const selectionGeneration = useRef(0);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(248);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workflowNotice, setWorkflowNotice] = useState<{
    workflowId: string;
    title: string;
    status: string;
    summary: string;
  }>();
  const moreButton = useRef<HTMLButtonElement>(null);
  const closeDetailsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    const subscription = listen<unknown>("host://workflow-notice", ({ payload }) => {
      if (!active || !payload || typeof payload !== "object") return;
      const value = payload as Record<string, unknown>;
      if (
        typeof value.workflowId === "string" &&
        typeof value.title === "string" &&
        typeof value.summary === "string" &&
        ["completed", "needs_user"].includes(String(value.status))
      )
        setWorkflowNotice({
          workflowId: value.workflowId,
          title: value.title,
          summary: value.summary,
          status: String(value.status),
        });
    });
    return () => {
      active = false;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!detailsOpen) return;
    closeDetailsButton.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailsOpen(false);
        moreButton.current?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detailsOpen]);
  const current = tasks.find((task) => task.id === selected);
  const selectConversationTask = useCallback((taskId: string) => {
    setSelected(taskId);
  }, []);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const update = (value: unknown) => {
      const parsed = parseClientSessions(value);
      if (active) setSessions(parsed);
    };
    const subscription = listen<unknown>("host://client-sessions", ({ payload }) => {
      try {
        update(payload);
        receivedEvent = true;
      } catch {
        if (active) setError("会话列表读取失败");
      }
    });
    // 快照读取期间可能发生切换；实时事件优先，不能被较早的快照回退。
    void subscription
      .then(() => invoke("get_client_sessions"))
      .then((value) => {
        if (!receivedEvent) update(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, []);

  async function mutateSession(command: string, args: Record<string, unknown>) {
    if (changingSessionRef.current) throw new Error("会话正在更新，请稍候");
    changingSessionRef.current = true;
    setChangingSession(true);
    setError("");
    try {
      setSessions(parseClientSessions(await invoke(command, args)));
      ++selectionGeneration.current;
      setArtifact(undefined);
      setDetailsOpen(false);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "会话切换失败");
      // 超时不重试；重新读取 Host 的真实选择，避免显示乐观的虚假 Session。
      await invoke("get_client_sessions")
        .then((value) => setSessions(parseClientSessions(value)))
        .catch(() => {});
      throw cause;
    } finally {
      changingSessionRef.current = false;
      setChangingSession(false);
    }
  }

  function changeSession(sessionId: string) {
    if (changingSessionRef.current || sessionId === activeSessionId) return;
    void mutateSession("change_client_session", { sessionId }).catch(() => {});
  }

  async function submitSessionDialog(title?: string) {
    if (!sessionDialog) return;
    if (sessionDialog.kind === "rename") {
      await mutateSession("rename_client_session", {
        sessionId: sessionDialog.session.sessionId,
        title,
      });
    } else {
      await mutateSession(
        "change_client_session",
        sessionDialog.kind === "create"
          ? { sessionId: null, title }
          : { sessionId: null, deleteSessionId: sessionDialog.session.sessionId },
      );
    }
  }

  useEffect(() => {
    let active = true;
    const update = (id: string, change: (task: ResearchTask) => ResearchTask) => {
      if (!active) return;
      setTasks((items) => {
        const old = items.find((task) => task.id === id) ?? {
          id,
          label: "资料调研",
          steps: [],
          sources: [],
        };
        return [change(old), ...items.filter((task) => task.id !== id)];
      });
    };
    const subscriptions = [
      listen<VoiceSettings>("host://voice-settings", ({ payload }) => {
        if (active) setVoiceSettings(payload);
      }),
      listen<{ operationId: string; value: { toolName: string; inputJson: string } }>(
        "host://research-confirmation",
        ({ payload }) => {
          if (active)
            setConfirmations((items) => [
              ...items.filter((item) => item.operationId !== payload.operationId),
              payload,
            ]);
        },
      ),
      listen<string>("host://research-confirmation-expired", ({ payload }) => {
        if (active)
          setConfirmations((items) => items.filter((item) => item.operationId !== payload));
      }),
      listen<Source>("host://research-source", ({ payload }) => {
        update(payload.taskId, (task) => ({
          ...task,
          sources: [...task.sources.filter((s) => s.sourceId !== payload.sourceId), payload],
        }));
      }),
      listen<string>("host://research-error", ({ payload }) => {
        if (active) setError(payload);
      }),
      listen<boolean>("host://assistant-visibility-changed", ({ payload }) => {
        if (active) setVisible(payload);
      }),
      listen<WorkerMessage>("host://worker-message", ({ payload: message }) => {
        if (message.direction !== "event") return;
        const payload = message.payload;
        if (
          message.kind === "research.progress" &&
          typeof payload.taskId === "string" &&
          typeof payload.label === "string"
        ) {
          update(payload.taskId, (task) => ({
            ...task,
            label: String(payload.label),
            steps: [...task.steps, String(payload.label)],
          }));
        } else if (message.kind === "research.report" && typeof payload.taskId === "string") {
          const taskId = payload.taskId;
          update(taskId, (task) => ({
            ...task,
            label: "报告已保存",
            report: payload as unknown as Report,
          }));
          // 插话报告可复用同会话旧轮次证据，按 Host 校验后的集合补齐来源；
          // 不修改当前选择，迟到查询只更新其所属任务且不覆盖实时来源。
          void invoke<Source[]>("get_research_sources", { taskId })
            .then((sources) =>
              update(taskId, (task) => ({
                ...task,
                sources: [
                  ...sources.filter(
                    (source) => !task.sources.some((item) => item.sourceId === source.sourceId),
                  ),
                  ...task.sources,
                ],
              })),
            )
            .catch(() => {
              if (active) setError("报告来源读取失败，请重新打开客户端重试");
            });
        } else if (message.kind === "research.receipt" && typeof payload.taskId === "string") {
          update(payload.taskId, (task) => ({
            ...task,
            steps: [
              ...task.steps,
              `${String(payload.toolName)} · ${String(payload.status)}${typeof payload.outputSummary === "string" ? ` · ${payload.outputSummary}` : ""}`,
            ],
          }));
        }
      }),
    ].map((promise) => promise.catch(() => undefined));
    void invoke<boolean>("get_assistant_visibility")
      .then((value) => {
        if (active) setVisible(value);
      })
      .catch(() => {});
    void invoke<VoiceSettings>("get_voice_settings")
      .then((value) => {
        if (active) setVoiceSettings(value);
      })
      .catch(() => {});
    void invoke<ResearchTask[]>("get_research_archive")
      .then((archive) => {
        if (!active) return;
        // 加载期间的实时事件优先，不能被启动快照覆盖。
        setTasks((live) => [
          ...live.map((task) => {
            const saved = archive.find((item) => item.id === task.id);
            return saved
              ? {
                  ...saved,
                  ...task,
                  report: task.report ?? saved.report,
                  steps: [...saved.steps, ...task.steps],
                  sources: [
                    ...saved.sources.filter(
                      (source) => !task.sources.some((item) => item.sourceId === source.sourceId),
                    ),
                    ...task.sources,
                  ],
                }
              : task;
          }),
          ...archive.filter((task) => !live.some((item) => item.id === task.id)),
        ]);
      })
      .catch(() => {});
    return () => {
      active = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop?.());
    };
  }, []);

  async function toggleAssistant() {
    try {
      await invoke("set_assistant_visible", { visible: !visible });
    } catch {
      setError("桌面助手需要在 Tauri 客户端中运行");
    }
  }
  async function changeVoiceSettings(patch: Partial<VoiceSettings>) {
    if (!voiceSettings || savingVoiceRef.current) return;
    savingVoiceRef.current = true;
    setSavingVoice(true);
    try {
      await invoke("set_voice_settings", { settings: { ...voiceSettings, ...patch } });
    } catch {
      setError("语音设置保存失败");
    } finally {
      savingVoiceRef.current = false;
      setSavingVoice(false);
    }
  }
  async function openLoginBrowser() {
    try {
      await invoke("send_worker_request", {
        envelope: {
          direction: "request",
          protocolVersion: 1,
          requestId: `req_login_${crypto.randomUUID().replaceAll("-", "")}`,
          kind: "browser.login.open",
          payload: {},
        },
      });
    } catch {
      setError("无法打开浏览器，请检查 Worker 是否已就绪");
    }
  }
  async function selectSource(source: Source) {
    const generation = ++selectionGeneration.current;
    setArtifact(undefined);
    if (!source.artifactId) {
      setError(source.reason ?? "该来源没有正文");
      return;
    }
    try {
      const text = await invoke<string | null>("get_research_artifact", {
        taskId: source.taskId,
        artifactId: source.artifactId,
      });
      if (generation === selectionGeneration.current)
        setArtifact({ title: source.title, text: text ?? "正文不可用" });
    } catch {
      if (generation === selectionGeneration.current) setError("正文读取失败");
    }
  }
  function resizePanel(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftWidth;
    const update = (move: globalThis.PointerEvent) => {
      const delta = move.clientX - startX;
      const next = Math.max(0, Math.min(460, startWidth + delta));
      setLeftWidth(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", stop, { once: true });
  }
  return (
    <main
      className={`client-stage${detailsOpen ? " has-details" : ""}`}
      style={{ "--client-left-width": `${leftCollapsed ? 40 : leftWidth}px` } as CSSProperties}
    >
      <section className="client-workbench" aria-label="Semi-OS 工作台">
        <header className="client-topbar">
          <span className="client-wordmark">SemiOS</span>
          <button
            className="client-icon-button"
            aria-label={visible ? "收起助手" : "唤起助手"}
            title={visible ? "收起助手" : "唤起助手"}
            aria-pressed={visible}
            onClick={() => void toggleAssistant()}
          >
            <AgentIcon size={20} />
          </button>
        </header>
        <aside
          className={`client-sidebar${leftCollapsed ? " is-collapsed" : ""}`}
          aria-label="会话"
        >
          <div className="client-sidebar-head">
            <button
              className="client-icon-button"
              aria-label={leftCollapsed ? "展开会话栏" : "收起会话栏"}
              title={leftCollapsed ? "展开会话栏" : "收起会话栏"}
              onClick={() => setLeftCollapsed((value) => !value)}
            >
              {leftCollapsed ? <PanelIcon size={17} /> : <CollapseLeftIcon size={17} />}
            </button>
            <button
              className="client-icon-button"
              aria-label="新建会话"
              title="新建会话"
              disabled={changingSession || !activeSessionId}
              onClick={() => setSessionDialog({ kind: "create" })}
            >
              <NewSessionIcon size={18} />
            </button>
          </div>
          {!leftCollapsed && (
            <div className="client-session-list">
              {sessions.map((session) => (
                <button
                  key={session.sessionId}
                  className={`client-session-item${session.active ? " is-active" : ""}`}
                  aria-current={session.active ? "true" : undefined}
                  title={session.title}
                  disabled={changingSession}
                  onClick={() => changeSession(session.sessionId)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!changingSession)
                      setSessionMenu({
                        session,
                        x: event.clientX,
                        y: event.clientY,
                        trigger: event.currentTarget,
                      });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setSessionMenu({
                        session,
                        x: bounds.left + 16,
                        y: bounds.bottom,
                        trigger: event.currentTarget,
                      });
                    }
                  }}
                >
                  <span>{session.title}</span>
                </button>
              ))}
            </div>
          )}
          <div className="client-sidebar-footer">
            <button
              className="client-icon-button"
              aria-label="设置"
              title="设置"
              onClick={() => settingsDialog.current?.showModal()}
            >
              <SettingsIcon size={20} />
            </button>
          </div>
        </aside>
        {/* 折叠后仍保留占位分隔条，避免 CSS Grid 自动重排中间工作区。 */}
        <div
          className="client-resize-handle"
          role="separator"
          aria-label="调整会话栏宽度"
          onPointerDown={resizePanel}
        />
        <article className="client-conversation research-workbench">
          {error && (
            <p role="alert" className="research-error">
              {error}
            </p>
          )}
          <ConversationPanel sessionId={activeSessionId} onTaskChange={selectConversationTask} />
        </article>
        <aside className="client-context" aria-label="上下文">
          <header className="client-context-head">
            <span className="context-eyebrow">任务状态</span>
          </header>
          <AgentStatusIsland
            workflow={workflow}
            current={current}
            confirmation={Boolean(confirmation)}
            onOpenDetails={() => setDetailsOpen(true)}
          />
          {workflowNotice && (
            <div role="status" className="context-preview">
              <button
                className="context-more"
                onClick={() =>
                  void invoke<unknown>("get_workflow", { workflowId: workflowNotice.workflowId })
                    .then(async (value) => {
                      const found = parseWorkflowSnapshot(value);
                      if (found.plan.workflowId !== workflowNotice.workflowId)
                        throw new Error("任务身份不匹配");
                      await mutateSession("change_client_session", {
                        sessionId: found.plan.sessionId,
                      });
                      setDetailsOpen(true);
                      setWorkflowNotice(undefined);
                    })
                    .catch(() => setError("任务打开失败"))
                }
              >
                {workflowNotice.title} ·{" "}
                {workflowNotice.status === "completed" ? "已完成" : "待处理"}
              </button>
              <button
                className="client-icon-button"
                aria-label="关闭任务通知"
                title="关闭任务通知"
                onClick={() => setWorkflowNotice(undefined)}
              >
                <DismissIcon size={14} />
              </button>
            </div>
          )}
          <button
            ref={moreButton}
            className="context-more"
            aria-expanded={detailsOpen}
            aria-controls="research-details"
            onClick={() => setDetailsOpen((value) => !value)}
          >
            查看详情
          </button>
        </aside>
        <footer className="command-composer research-composer chat-composer">
          <TextComposer
            key={activeSessionId}
            disabled={changingSession || !activeSessionId}
            voiceEnabled={voiceSettings?.enabled}
          />
        </footer>
      </section>
      {/* 抽屉占据真实布局空间，展开时推开工作台，不遮挡对话与确认入口。 */}
      <motion.aside
        id="research-details"
        className="client-details-drawer"
        aria-label="完整资料"
        inert={!detailsOpen}
        initial={false}
        animate={{ x: detailsOpen ? 0 : "100%", opacity: detailsOpen ? 1 : 0.65 }}
        transition={{ type: "spring", stiffness: 360, damping: 34, mass: 0.8 }}
      >
        <header className="client-details-head">
          <strong>资料</strong>
          <button
            ref={closeDetailsButton}
            className="client-icon-button"
            aria-label="关闭资料"
            title="关闭资料"
            onClick={() => {
              setDetailsOpen(false);
              moreButton.current?.focus();
            }}
          >
            <DismissIcon size={18} />
          </button>
        </header>
        <div className="client-details-body">
          {workflowError && (
            <p className="research-error" role="alert">
              {workflowError}
            </p>
          )}
          {workflows.map((item) => (
            <WorkflowPanel key={`${item.plan.workflowId}:${item.plan.version}`} workflow={item} />
          ))}
          {current?.steps.length ? (
            <details className="context-section" open>
              <summary>
                进度 <span>{current.steps.length}</span>
              </summary>
              <ol className="context-steps">
                {current.steps.map((step, index) => (
                  <li key={`${step}-${index}`}>{step}</li>
                ))}
              </ol>
            </details>
          ) : null}
          {current?.report && (
            <details className="context-section">
              <summary>来源依据</summary>
              <div className="context-claims">
                {current.report.claims.map((claim, index) => (
                  <div key={index}>
                    <Markdown>{claim.text}</Markdown>
                    <div className="research-citations">
                      {claim.citations.map((citation) => {
                        const source = current.sources.find(
                          (item) => item.sourceId === citation.sourceId,
                        );
                        return (
                          <button
                            key={`${citation.sourceId}:${citation.quoteId}`}
                            disabled={!source}
                            title={
                              source?.quotes.find((quote) => quote.quoteId === citation.quoteId)
                                ?.text
                            }
                            onClick={() => source && void selectSource(source)}
                          >
                            {source?.title ?? "来源不可用"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          {current?.sources.length ? (
            <details className="context-section" open>
              <summary>
                来源 <span>{current.sources.length}</span>
              </summary>
              <div className="context-sources">
                {current.sources.map((source) => (
                  <button
                    key={source.sourceId}
                    className="context-source"
                    onClick={() => void selectSource(source)}
                    title={source.finalUrl}
                  >
                    <LinkIcon size={15} />
                    <span>{source.title}</span>
                  </button>
                ))}
              </div>
            </details>
          ) : null}
          {artifact && (
            <section className="client-artifact">
              <header>
                <strong>{artifact.title}</strong>
                <button
                  className="client-icon-button"
                  aria-label="关闭正文"
                  title="关闭正文"
                  onClick={() => setArtifact(undefined)}
                >
                  <DismissIcon size={16} />
                </button>
              </header>
              <pre className="research-body">{artifact.text}</pre>
            </section>
          )}
        </div>
      </motion.aside>
      <button
        className="client-icon-button client-mobile-settings"
        aria-label="设置"
        title="设置"
        onClick={() => settingsDialog.current?.showModal()}
      >
        <SettingsIcon size={20} />
      </button>
      {/* 原生 dialog 管理焦点、Escape 和背景交互隔离；设置仍通过 Host 保存。 */}
      <dialog
        ref={settingsDialog}
        className="client-settings"
        aria-labelledby="client-settings-title"
      >
        <header>
          <h2 id="client-settings-title">设置</h2>
          <button
            className="client-icon-button"
            aria-label="关闭设置"
            title="关闭设置"
            onClick={() => settingsDialog.current?.close()}
          >
            <DismissIcon size={18} />
          </button>
        </header>
        {voiceSettings && (
          <fieldset className="voice-settings">
            <legend className="sr-only">语音设置</legend>
            <label>
              <span>语音</span>
              <input
                type="checkbox"
                disabled={savingVoice}
                checked={voiceSettings.enabled}
                onChange={(event) => void changeVoiceSettings({ enabled: event.target.checked })}
              />
            </label>
            <label title="本地麦克风持续就绪，系统指示灯会常亮；未按键的声音不保存、不上传。">
              <span>麦克风预热</span>
              <input
                type="checkbox"
                disabled={!voiceSettings.enabled || savingVoice}
                checked={voiceSettings.prewarm}
                onChange={(event) => void changeVoiceSettings({ prewarm: event.target.checked })}
              />
            </label>
          </fieldset>
        )}
        <button className="client-settings-action" onClick={() => void openLoginBrowser()}>
          <span>浏览器登录</span>
          <LinkIcon size={17} />
        </button>
        {error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
      </dialog>
      {sessionMenu && (
        <SessionContextMenu
          position={sessionMenu}
          onClose={closeSessionMenu}
          onAction={(kind) => {
            setSessionDialog({ kind, session: sessionMenu.session });
            setSessionMenu(undefined);
          }}
        />
      )}
      {sessionDialog && (
        <SessionDialogView
          operation={sessionDialog}
          onClose={() => setSessionDialog(undefined)}
          onSubmit={submitSessionDialog}
        />
      )}
    </main>
  );
}
