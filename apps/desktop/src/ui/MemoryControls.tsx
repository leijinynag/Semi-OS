import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DismissIcon } from "./icons";
import {
  parseClientMemoryPage,
  projectMemoryPanel,
  readMemoryError,
  validatePreferenceDraft,
  type ClientMemoryPage,
  type MemoryPanelView,
} from "./memory-controls";

/**
 * 记忆与偏好对话框。成功与否只看 Host 返回的快照；人格区没有输入框。
 */
export function MemoryControls({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [page, setPage] = useState<ClientMemoryPage>();
  const [error, setError] = useState("");
  const [preferenceKey, setPreferenceKey] = useState("");
  const [preferenceValue, setPreferenceValue] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setError("");
    invoke("list_client_memory")
      .then((payload) => {
        if (cancelled) return;
        setPage(parseClientMemoryPage(payload));
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPage(undefined);
        setStatus("error");
        setError(readMemoryError(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const view: MemoryPanelView | undefined = page ? projectMemoryPanel(page) : undefined;

  function beginEdit(memoryId: string, key: string, value: string) {
    setEditingId(memoryId);
    setPreferenceKey(key);
    setPreferenceValue(value);
    setError("");
  }

  function resetForm() {
    setEditingId(undefined);
    setPreferenceKey("");
    setPreferenceValue("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let draft: { key: string; value: string };
    try {
      draft = validatePreferenceDraft(preferenceKey, preferenceValue);
    } catch (reason) {
      setError(readMemoryError(reason));
      return;
    }
    setPending(true);
    setError("");
    try {
      const payload = await invoke(
        editingId ? "revise_user_preference" : "create_user_preference",
        editingId ? { memoryId: editingId, ...draft } : draft,
      );
      setPage(parseClientMemoryPage(payload));
      setStatus("ready");
      resetForm();
    } catch (reason) {
      setError(readMemoryError(reason));
    } finally {
      setPending(false);
    }
  }

  async function remove(memoryId: string) {
    setPending(true);
    setError("");
    try {
      const payload = await invoke("delete_user_preference", { memoryId });
      setPage(parseClientMemoryPage(payload));
      setStatus("ready");
      if (editingId === memoryId) resetForm();
    } catch (reason) {
      setError(readMemoryError(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="client-settings memory-controls"
      aria-labelledby="memory-controls-title"
      aria-busy={status === "loading" || pending}
      onClose={onClose}
    >
      <header>
        <h2 id="memory-controls-title">记忆与偏好</h2>
        <button
          type="button"
          className="client-icon-button"
          aria-label="关闭记忆与偏好"
          title="关闭记忆与偏好"
          onClick={() => dialog.current?.close()}
        >
          <DismissIcon size={18} />
        </button>
      </header>
      {status === "loading" && <p className="memory-status">正在读取记忆</p>}
      {status === "error" && (
        <div className="memory-error">
          <p className="research-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="client-subtle-button"
            onClick={() => setReload((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
      {status === "ready" && view && (
        <div className="memory-controls-body">
          {error && (
            <p className="research-error" role="alert">
              {error}
            </p>
          )}
          <p className="memory-persona">{view.personaLine}</p>
          <section className="memory-section" aria-label="我的偏好">
            <h3>我的偏好</h3>
            <p className="memory-note">偏好只改这条记录，不会改人格。</p>
            {view.preferenceEmpty ? (
              <p className="memory-empty">{view.preferenceEmpty}</p>
            ) : (
              <ul className="memory-list">
                {view.preferences.map((row) => (
                  <li key={row.memoryId} className="memory-row">
                    <div className="memory-row-copy">
                      <strong>{row.key}</strong>
                      <span>{row.value}</span>
                      <small>
                        {row.authorLabel} · {row.mutabilityLabel}
                      </small>
                    </div>
                    {row.editable && (
                      <div className="memory-row-actions">
                        <button
                          type="button"
                          className="client-subtle-button"
                          disabled={pending}
                          onClick={() => beginEdit(row.memoryId, row.key, row.value)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="client-subtle-button"
                          disabled={pending}
                          onClick={() => void remove(row.memoryId)}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form className="memory-form" onSubmit={(event) => void submit(event)}>
              <label htmlFor="memory-preference-key">名称</label>
              <input
                id="memory-preference-key"
                value={preferenceKey}
                disabled={pending}
                onChange={(event) => setPreferenceKey(event.target.value)}
              />
              <label htmlFor="memory-preference-value">内容</label>
              <input
                id="memory-preference-value"
                value={preferenceValue}
                disabled={pending}
                onChange={(event) => setPreferenceValue(event.target.value)}
              />
              <div className="memory-form-actions">
                {editingId && (
                  <button
                    type="button"
                    className="client-subtle-button"
                    disabled={pending}
                    onClick={resetForm}
                  >
                    取消编辑
                  </button>
                )}
                <button type="submit" className="client-dark-button" disabled={pending}>
                  {editingId ? "保存修改" : "添加偏好"}
                </button>
              </div>
            </form>
          </section>
          <section className="memory-section" aria-label="记忆">
            <h3>记忆</h3>
            <p className="memory-note">只读。每条记录标明作者和谁可以改。</p>
            {view.memoryEmpty ? (
              <p className="memory-empty">{view.memoryEmpty}</p>
            ) : (
              <ul className="memory-list">
                {view.memories.map((row) => (
                  <li key={row.memoryId} className="memory-row">
                    <div className="memory-row-copy">
                      <strong>
                        {row.layer} · {row.recordKind}
                      </strong>
                      <span>{row.summary}</span>
                      <small>
                        {row.authorLabel} · {row.mutabilityLabel}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </dialog>
  );
}
