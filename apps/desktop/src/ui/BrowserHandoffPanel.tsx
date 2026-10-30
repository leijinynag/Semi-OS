import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { assertValidEnvelope, type EventPayloads, type RequestPayloads } from "@semi-os/protocol";
import { ApproveIcon, ResumeIcon, WaitingIcon } from "./icons";

type BrowserState = EventPayloads["browser.session.state"];

/** UI 只发送当前接管票据，不接收/构造 Space ID。先订阅再查快照，
 * 避免窗口重开时丢失等待状态，也不让迟到快照覆盖实时状态。
 */
export function BrowserHandoffPanel({ sessionId }: { sessionId?: string }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const request = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    let stop: (() => void) | undefined;
    mounted.current = true;
    const snapshotId = `req_browser_inspect_${crypto.randomUUID().replaceAll("-", "")}`;
    void listen<unknown>("host://worker-message", ({ payload: message }) => {
      if (!active) return;
      try {
        assertValidEnvelope(message);
      } catch {
        return;
      }
      if (message.direction === "event" && message.kind === "browser.session.state") {
        receivedEvent = true;
        setState(message.payload);
        setError("");
      } else if (
        !receivedEvent &&
        message.direction === "response" &&
        message.kind === "browser.session.snapshot" &&
        message.requestId === snapshotId
      ) {
        setState(message.payload);
      }
      if (message.requestId === request.current) {
        if (
          message.direction === "error" ||
          (message.direction === "response" && message.kind === "browser.session.resume.accepted")
        ) {
          clearTimeout(timer.current);
          request.current = undefined;
          setSending(false);
          if (message.direction === "error") setError("继续请求未被接受，请核对当前任务后重试");
        }
      }
    })
      .then((unlisten) => {
        stop = unlisten;
        if (!active) return unlisten();
        return invoke("send_worker_request", {
          envelope: {
            direction: "request",
            protocolVersion: 1,
            requestId: snapshotId,
            kind: "browser.session.inspect",
            payload: {},
          },
        });
      })
      .catch(() => {
        if (active) setError("浏览器接管状态读取失败，请重新打开客户端");
      });
    return () => {
      active = false;
      mounted.current = false;
      stop?.();
      clearTimeout(timer.current);
    };
  }, []);

  async function resume(mode: "takeover" | "claim") {
    if (!state || state.sessionId !== sessionId || request.current) return;
    // claim 必须是独立、明确的用户动作，绝不由 takeover 失败自动触发。
    if (
      mode === "claim" &&
      !window.confirm("确认认领原 Ego Space？这会将该 Space 的浏览器控制权交给当前任务。")
    )
      return;
    const requestId = `req_browser_resume_${crypto.randomUUID().replaceAll("-", "")}`;
    request.current = requestId;
    setSending(true);
    setError("");
    const payload: RequestPayloads["browser.session.resume"] = {
      resumeId: state.resumeId,
      sessionId: state.sessionId,
      taskId: state.taskId,
      mode,
    };
    timer.current = setTimeout(() => {
      if (!mounted.current || request.current !== requestId) return;
      request.current = undefined;
      setSending(false);
      setError("请求送达未确认；请查看当前状态，未自动重试");
    }, 15_000);
    try {
      await invoke("send_worker_request", {
        envelope: {
          direction: "request",
          protocolVersion: 1,
          requestId,
          kind: "browser.session.resume",
          payload,
        },
      });
    } catch {
      if (!mounted.current || request.current !== requestId) return;
      clearTimeout(timer.current);
      request.current = undefined;
      setSending(false);
      setError("继续请求发送失败，未自动认领或重试");
    }
  }

  if (!state || state.sessionId !== sessionId) {
    return error ? (
      <p className="research-error" role="alert">
        {error}
      </p>
    ) : null;
  }
  const waiting = state.status === "waiting_user" || state.status === "failed";
  const busy = sending || state.status === "resuming";
  const label = {
    waiting_user: "需要在浏览器处理",
    resuming: "正在恢复原任务",
    resumed: "原任务已继续",
    failed: "恢复未完成",
    cancelled: "接管等待已取消",
  }[state.status];
  return (
    <section className="browser-handoff" aria-label="浏览器接管" aria-busy={busy}>
      <div className="browser-handoff-status" role="status" aria-live="polite">
        <WaitingIcon size={18} />
        <strong>{label}</strong>
      </div>
      <p>{state.message}</p>
      {error && (
        <p className="research-error" role="alert">
          {error}
        </p>
      )}
      {(waiting || busy) && (
        <div className="browser-handoff-actions">
          <button
            className="client-dark-button"
            disabled={busy}
            onClick={() => void resume("takeover")}
          >
            <ResumeIcon size={16} />
            {busy ? "正在恢复…" : "已处理，继续"}
          </button>
          {state.status === "failed" && (
            <button
              className="client-subtle-button"
              disabled={busy}
              onClick={() => void resume("claim")}
            >
              <ApproveIcon size={16} />
              认领原 Space
            </button>
          )}
        </div>
      )}
    </section>
  );
}
