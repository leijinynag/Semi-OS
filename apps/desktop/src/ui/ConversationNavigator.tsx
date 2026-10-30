import { useEffect, useRef, useState, type RefObject } from "react";
import type { ConversationTurn } from "./ConversationPanel";

/** 只导航当前已展示的轮次，不创建会话，也不改变 Host 的任务选择。 */
export function ConversationNavigator({
  turns,
  panel,
  onNavigate,
}: {
  turns: ConversationTurn[];
  panel: RefObject<HTMLElement | null>;
  onNavigate: () => void;
}) {
  const [activeId, setActiveId] = useState("");
  const [previewId, setPreviewId] = useState("");
  const [previewTop, setPreviewTop] = useState(0);
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    const scroller = panel.current?.closest<HTMLElement>(".research-workbench");
    const content = panel.current;
    if (!scroller || !content) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const readingLine = scroller.getBoundingClientRect().top + 80;
      const articles = Array.from(content.querySelectorAll<HTMLElement>("[data-turn-id]"));
      let current = articles[0];
      for (const article of articles) {
        if (article.getBoundingClientRect().top > readingLine) break;
        current = article;
      }
      setActiveId(current?.dataset.turnId ?? "");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // 流式内容、详情展开和窗口变化都可能改变轮次位置，不能仅在滚动时更新。
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [panel, turns]);

  function jump(requestId: string) {
    const scroller = panel.current?.closest<HTMLElement>(".research-workbench");
    const article = Array.from(
      panel.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [],
    ).find((element) => element.dataset.turnId === requestId);
    if (!scroller || !article) return;
    onNavigate();
    const top =
      article.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      24;
    scroller.scrollTo({
      top: Math.max(0, top),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    setActiveId(requestId);
    setPreviewId("");
  }

  function preview(requestId: string, target: HTMLElement) {
    const bounds = rail.current?.getBoundingClientRect();
    if (!bounds) return;
    setPreviewId(requestId);
    setPreviewTop(
      Math.max(
        0,
        Math.min(target.getBoundingClientRect().top - bounds.top - 32, bounds.height - 160),
      ),
    );
  }

  const previewIndex = turns.findIndex((turn) => turn.requestId === previewId);
  if (!turns.length) return null;
  return (
    <div className="conversation-navigation-anchor">
      <nav
        ref={rail}
        className="conversation-navigation"
        aria-label="对话跳转"
        onMouseLeave={() => setPreviewId("")}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPreviewId("");
        }}
      >
        <div className="conversation-ticks">
          {turns.map((turn, index) => (
            <button
              key={turn.requestId}
              className={`conversation-tick${activeId === turn.requestId ? " is-active" : ""}`}
              aria-label={`跳转到第 ${index + 1} 轮：${turn.transcript || "语音对话"}`}
              aria-current={activeId === turn.requestId ? "location" : undefined}
              onMouseEnter={(event) => preview(turn.requestId, event.currentTarget)}
              onFocus={(event) => preview(turn.requestId, event.currentTarget)}
              onClick={() => jump(turn.requestId)}
            >
              <span />
            </button>
          ))}
        </div>
        {previewIndex >= 0 && (
          <div className="conversation-jump-preview" style={{ top: previewTop }}>
            {turns.slice(previewIndex, previewIndex + 2).map((turn) => (
              <button key={turn.requestId} onClick={() => jump(turn.requestId)}>
                <strong>{turn.transcript || "语音对话"}</strong>
                <span>{turn.summary || turn.assistantText || turn.error || "正在回复…"}</span>
              </button>
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}
