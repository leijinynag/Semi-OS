import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DeleteIcon, DismissIcon, RenameIcon } from "./icons";
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
 *
 * 添加表单是偏好 section 的一部分，默认收起；只有空偏好列表在首次加载时
 * 自动展开一次，避免用户面对空白 section 找不到入口。编辑复用同一表单，
 * 因此界面上始终只有一个偏好编辑区。
 */
export function MemoryControls({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [page, setPage] = useState<ClientMemoryPage>();
  const [error, setError] = useState("");
  const [preferenceKey, setPreferenceKey] = useState("");
  const [preferenceValue, setPreferenceValue] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
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
    setPage(undefined);
    setStatus("loading");
    setEditingId(undefined);
    setPreferenceKey("");
    setPreferenceValue("");
    setEditorOpen(false);
    setError("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setError("");
    invoke("list_client_memory")
      .then((payload) => {
        if (cancelled) return;
        const next = parseClientMemoryPage(payload);
        setPage(next);
        // 空列表才自动展开；有数据时保持 section 紧凑，由“添加”显式打开。
        setEditorOpen(next.preferences.length === 0);
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

  function beginAdd() {
    setEditingId(undefined);
    setPreferenceKey("");
    setPreferenceValue("");
    setEditorOpen(true);
    setError("");
  }

  function beginEdit(memoryId: string, key: string, value: string) {
    setEditingId(memoryId);
    setPreferenceKey(key);
    setPreferenceValue(value);
    setEditorOpen(true);
    setError("");
  }

  function cancelEdit() {
    setEditingId(undefined);
    setPreferenceKey("");
    setPreferenceValue("");
    setEditorOpen(false);
    setError("");
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
      setEditingId(undefined);
      setPreferenceKey("");
      setPreferenceValue("");
      setEditorOpen(false);
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
      if (editingId === memoryId) cancelEdit();
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
      <header className="memory-controls-header">
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
          <section className="memory-section" aria-labelledby="memory-preferences-heading">
            <div className="memory-section-head">
              <h3 id="memory-preferences-heading">偏好</h3>
              {!editorOpen && (
                <button
                  type="button"
                  className="memory-ghost-button"
                  disabled={pending}
                  onClick={beginAdd}
                >
                  添加
                </button>
              )}
            </div>
            {view.preferences.length === 0 ? (
              !editorOpen && <p className="memory-empty">{view.preferenceEmpty}</p>
            ) : (
              <ul className="memory-list memory-preference-list">
                {view.preferences.map((row) => (
                  <li key={row.memoryId} className="memory-preference-row">
                    <div className="memory-preference-copy">
                      <span className="memory-preference-key">{row.key}</span>
                      <span className="memory-preference-value">{row.value}</span>
                      <small className="memory-preference-meta">{row.metaLabel}</small>
                    </div>
                    {row.editable && (
                      <div className="memory-row-actions">
                        <button
                          type="button"
                          className="memory-icon-button"
                          aria-label={`编辑偏好 ${row.key}`}
                          title={`编辑偏好 ${row.key}`}
                          disabled={pending}
                          onClick={() => beginEdit(row.memoryId, row.key, row.value)}
                        >
                          <RenameIcon size={16} />
                        </button>
                        <button
                          type="button"
                          className="memory-icon-button is-destructive"
                          aria-label={`删除偏好 ${row.key}`}
                          title={`删除偏好 ${row.key}`}
                          disabled={pending}
                          onClick={() => void remove(row.memoryId)}
                        >
                          <DeleteIcon size={16} />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editorOpen && (
              <form className="memory-form" onSubmit={(event) => void submit(event)}>
                <label className="memory-field" htmlFor="memory-preference-key">
                  <span>名称</span>
                  <input
                    id="memory-preference-key"
                    value={preferenceKey}
                    disabled={pending}
                    autoFocus
                    onChange={(event) => setPreferenceKey(event.target.value)}
                  />
                </label>
                <label className="memory-field" htmlFor="memory-preference-value">
                  <span>内容</span>
                  <input
                    id="memory-preference-value"
                    value={preferenceValue}
                    disabled={pending}
                    onChange={(event) => setPreferenceValue(event.target.value)}
                  />
                </label>
                <div className="memory-form-actions">
                  <button
                    type="button"
                    className="memory-ghost-button"
                    disabled={pending}
                    onClick={cancelEdit}
                  >
                    取消
                  </button>
                  <button type="submit" className="client-dark-button" disabled={pending}>
                    {editingId ? "保存" : "添加"}
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="memory-section" aria-labelledby="memory-records-heading">
            <div className="memory-section-head">
              <h3 id="memory-records-heading">记忆</h3>
            </div>
            <p className="memory-note">只读 · 含作者与权限</p>
            {view.memoryEmpty ? (
              <p className="memory-empty">{view.memoryEmpty}</p>
            ) : (
              <ul className="memory-list memory-record-list">
                {view.memories.map((row) => (
                  <li key={row.memoryId} className="memory-record-row">
                    <div className="memory-record-copy">
                      <span className="memory-record-kind">
                        {row.layer} · {row.recordKind}
                      </span>
                      <span className="memory-record-summary">{row.summary}</span>
                      <small className="memory-record-meta">{row.metaLabel}</small>
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
