import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConversationNavigator } from "./ConversationNavigator";

export interface ConversationTurn {
  requestId: string;
  sessionId: string;
  taskId: string;
  state: string;
  transcript: string;
  assistantText: string;
  summary: string;
  report: string;
  revision: number;
  error?: string;
}

function valid(value: unknown): value is ConversationTurn {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["requestId", "sessionId", "taskId", "state", "transcript", "assistantText", "summary", "report"].every((field) =>
    typeof record[field] === "string") && Number.isSafeInteger(record.revision);
}

const markdownPlugins = [remarkGfm];
export function Markdown({ children }: { children: string }) {
  return <div className="conversation-markdown"><ReactMarkdown
    remarkPlugins={markdownPlugins} skipHtml
    components={{ a: ({ children: label, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{label}</a> }}
  >{children}</ReactMarkdown></div>;
}

/** 客户端只订阅 Host 快照；不会录音、播放或从模型标记推测状态。 */
export function ConversationPanel({ sessionId, onTaskChange }: {
  sessionId: string;
  onTaskChange: (taskId: string) => void;
}) {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const panel = useRef<HTMLElement>(null);
  const following = useRef(true);
  useEffect(() => {
    following.current = true;
  }, [sessionId]);
  useEffect(() => {
    const scroller = panel.current?.closest(".research-workbench");
    if (!scroller) return;
    const onScroll = () => {
      following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (following.current) panel.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [turns, sessionId]);
  useEffect(() => {
    let active = true;
    const merge = (incoming: ConversationTurn[], archive = false) => {
      if (!active) return;
      setTurns((previous) => {
        const byId = new Map(previous.map((turn) => [turn.requestId, turn]));
        for (const turn of incoming) {
          const existing = byId.get(turn.requestId);
          // 切换后用归档恢复中断轮次的完整文字；较新的播放事件仍然优先。
          if (!existing || turn.revision > existing.revision ||
            (archive && turn.revision === existing.revision)) byId.set(turn.requestId, turn);
        }
        const newIds = incoming.filter((turn) => !previous.some((item) => item.requestId === turn.requestId)).map((turn) => turn.requestId);
        return [...newIds.map((id) => byId.get(id)!), ...previous.map((turn) => byId.get(turn.requestId)!)].slice(0, 200);
      });
    };
    const subscription = listen<unknown>("host://voice-snapshot", ({ payload }) => {
      if (valid(payload)) merge([payload]);
    }).catch(() => undefined);
    void subscription.then(() => invoke<unknown[]>("get_voice_conversations"))
      .then((values) => merge(values.filter(valid), true)).catch(() => {});
    return () => { active = false; void subscription.then((stop) => stop?.()); };
  }, [sessionId]);
  const chronological = turns.filter((turn) => turn.sessionId === sessionId).reverse();
  const latestTaskId = chronological.at(-1)?.taskId ?? "";
  useEffect(() => { onTaskChange(latestTaskId); }, [latestTaskId, onTaskChange]);
  return <>
    <ConversationNavigator turns={chronological} panel={panel} onNavigate={() => { following.current = false; }} />
    <section ref={panel} className="conversation-panel" aria-label="对话">
    {chronological.map((turn) => <article key={turn.requestId} data-turn-id={turn.requestId} className={`conversation-turn${["thinking", "speaking"].includes(turn.state) ? " is-streaming" : ""}`}>
      {turn.transcript && <div className="conversation-message conversation-message-user"><p>{turn.transcript}</p></div>}
      {(turn.assistantText || turn.error) && <div className="conversation-message conversation-message-agent conversation-answer" aria-live="polite">
        <Markdown>{turn.assistantText || turn.summary}</Markdown>
      </div>}
      {!turn.assistantText && !turn.error && ["listening", "transcribing", "thinking"].includes(turn.state) &&
        <p className="conversation-waiting" role="status">{turn.state === "thinking" ? "正在回复…" : turn.state === "listening" ? "正在聆听…" : "正在识别…"}</p>}
      {turn.error && <p role="alert" className="research-error">{turn.error}</p>}
      {turn.report && <details className="conversation-report">
        <summary>展开详细内容</summary><Markdown>{turn.report}</Markdown>
      </details>}
    </article>)}
  </section></>;
}
