import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { DeleteIcon, RenameIcon } from "./icons";
import { validateSessionTitle, type ClientSession } from "./client-sessions";

export type SessionDialog =
  | { kind: "create" }
  | { kind: "rename" | "delete"; session: ClientSession };

interface DialogProps {
  operation: SessionDialog;
  onClose(): void;
  onSubmit(title?: string): Promise<void>;
}

/** 原生模态层隔离背景操作；只有 Host 成功回执后关闭，失败保留输入以便修正。 */
export function SessionDialogView({ operation, onClose, onSubmit }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(operation.kind === "rename" ? operation.session.title : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const deleting = operation.kind === "delete";
  const heading = operation.kind === "create" ? "新建会话" : deleting ? "删除会话" : "重命名";
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>("input")?.select();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    setError("");
    try {
      const name = deleting ? undefined : validateSessionTitle(title);
      busyRef.current = true;
      setBusy(true);
      await onSubmit(name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "操作失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return createPortal(
    <dialog ref={dialog} className="client-settings session-dialog" aria-labelledby="session-dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="session-dialog-title">{heading}</h2>
        {deleting
          ? <p className="session-delete-copy">删除“{operation.session.title}”及其对话记录？此操作无法撤销。</p>
          : <label className="session-name-label">会话名称
            <input autoFocus value={title} maxLength={80} disabled={busy} autoComplete="off"
              onChange={(event) => setTitle(event.target.value)} />
          </label>}
        {error && <p className="research-error" role="alert">{error}</p>}
        <div className="session-dialog-actions">
          <button type="button" className="client-subtle-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" autoFocus={deleting} className="client-dark-button"
            disabled={busy || (!deleting && !title.trim())}>{deleting ? "删除" : "确定"}</button>
        </div>
      </form>
    </dialog>, document.body,
  );
}

export interface SessionMenuPosition {
  session: ClientSession;
  x: number;
  y: number;
  trigger: HTMLElement;
}

export function SessionContextMenu({ position, onClose, onAction }: {
  position: SessionMenuPosition;
  onClose(): void;
  onAction(kind: "rename" | "delete"): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = menu.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element?.contains(event.target)) onClose();
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      if (document.activeElement === document.body || element?.contains(document.activeElement)) {
        position.trigger.focus();
      }
    };
  }, [onClose, position]);
  return createPortal(
    <div ref={menu} className="session-context-menu" role="menu" aria-label={position.session.title}
      style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 168)),
        top: Math.max(8, Math.min(position.y, window.innerHeight - 96)) }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <button type="button" role="menuitem" onClick={() => onAction("rename")}><RenameIcon size={16} />重命名</button>
      <button type="button" role="menuitem" onClick={() => onAction("delete")}><DeleteIcon size={16} />删除</button>
    </div>, document.body,
  );
}
