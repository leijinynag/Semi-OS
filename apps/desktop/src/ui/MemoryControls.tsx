import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DismissIcon } from "./icons";
import {
  MEMORY_COMMANDS,
  parseClientMemoryPage,
  projectMemoryPanel,
  readMemoryError,
  validateCorrectionDraft,
  validatePreferenceDraft,
  type ClientMemoryPage,
  type MemoryPanelItem,
  type MemoryPanelView,
} from "./memory-controls";

/**
 * 记忆页按 Host 快照分节。纠正、停用、忘记和恢复都把整页快照换回来，
 * 不在界面上改原文。查看来源只展开快照里的来源，不另开数据库。
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
  const [correctingId, setCorrectingId] = useState<string>();
  const [correctionText, setCorrectionText] = useState("");
  const [sourceId, setSourceId] = useState<string>();
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
    setCorrectingId(undefined);
    setCorrectionText("");
    setSourceId(undefined);
    setError("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setError("");
    invoke(MEMORY_COMMANDS.list)
      .then((payload) => {
        if (cancelled) return;
        const next = parseClientMemoryPage(payload);
        setPage(next);
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

  function applyPage(payload: unknown) {
    setPage(parseClientMemoryPage(payload));
    setStatus("ready");
    setError("");
  }

  function beginAdd() {
    setEditingId(undefined);
    setPreferenceKey("");
    setPreferenceValue("");
    setEditorOpen(true);
    setCorrectingId(undefined);
    setError("");
  }

  function beginEdit(memoryId: string, key: string, value: string) {
    setEditingId(memoryId);
    setPreferenceKey(key);
    setPreferenceValue(value);
    setEditorOpen(true);
    setCorrectingId(undefined);
    setError("");
  }

  function beginCorrect(row: MemoryPanelItem) {
    setCorrectingId(row.memoryId);
    setCorrectionText(row.preferenceValue ?? row.summary);
    setEditorOpen(false);
    setEditingId(undefined);
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
        editingId ? MEMORY_COMMANDS.revisePreference : MEMORY_COMMANDS.createPreference,
        editingId ? { memoryId: editingId, ...draft } : draft,
      );
      applyPage(payload);
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

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctingId) return;
    let text: string;
    try {
      text = validateCorrectionDraft(correctionText);
    } catch (reason) {
      setError(readMemoryError(reason));
      return;
    }
    await runCommand(MEMORY_COMMANDS.correct, { memoryId: correctingId, text }, () => {
      setCorrectingId(undefined);
      setCorrectionText("");
    });
  }

  async function runCommand(
    command: string,
    args: { memoryId: string; text?: string },
    after?: () => void,
  ) {
    setPending(true);
    setError("");
    try {
      const payload = await invoke(command, args);
      applyPage(payload);
      after?.();
      if (editingId === args.memoryId) cancelEdit();
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
          <p className="memory-note">{view.voiceNote}</p>
          {view.sections.map((section) => (
            <section
              key={section.id}
              className="memory-section"
              aria-labelledby={`memory-section-${section.id}`}
              data-section={section.id}
            >
              <div className="memory-section-head">
                <h3 id={`memory-section-${section.id}`}>{section.title}</h3>
                {section.id === "user_settings" && !editorOpen && (
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
              {section.empty ? (
                <p className="memory-empty">{section.empty}</p>
              ) : (
                <ul className="memory-list memory-record-list">
                  {section.items.map((row) => (
                    <MemoryItem
                      key={row.memoryId}
                      row={row}
                      pending={pending}
                      sourceOpen={sourceId === row.memoryId}
                      correcting={correctingId === row.memoryId}
                      correctionText={correctionText}
                      onToggleSource={() =>
                        setSourceId((current) =>
                          current === row.memoryId ? undefined : row.memoryId,
                        )
                      }
                      onEdit={() =>
                        beginEdit(row.memoryId, row.preferenceKey ?? "", row.preferenceValue ?? "")
                      }
                      onCorrect={() => beginCorrect(row)}
                      onCorrectionText={setCorrectionText}
                      onSubmitCorrection={(event) => void submitCorrection(event)}
                      onCancelCorrection={() => {
                        setCorrectingId(undefined);
                        setCorrectionText("");
                      }}
                      onDisable={() =>
                        void runCommand(MEMORY_COMMANDS.disable, { memoryId: row.memoryId })
                      }
                      onForget={() =>
                        void runCommand(MEMORY_COMMANDS.forget, { memoryId: row.memoryId })
                      }
                      onRestore={() =>
                        void runCommand(MEMORY_COMMANDS.restore, { memoryId: row.memoryId })
                      }
                    />
                  ))}
                </ul>
              )}
              {section.id === "user_settings" && editorOpen && (
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
          ))}
          {view.forgotten.length > 0 && (
            <section className="memory-section" aria-labelledby="memory-forgotten-heading">
              <div className="memory-section-head">
                <h3 id="memory-forgotten-heading">{view.forgottenTitle}</h3>
              </div>
              <ul className="memory-list memory-record-list">
                {view.forgotten.map((row) => (
                  <MemoryItem
                    key={row.memoryId}
                    row={row}
                    pending={pending}
                    sourceOpen={sourceId === row.memoryId}
                    correcting={false}
                    correctionText=""
                    onToggleSource={() =>
                      setSourceId((current) =>
                        current === row.memoryId ? undefined : row.memoryId,
                      )
                    }
                    onEdit={() => undefined}
                    onCorrect={() => undefined}
                    onCorrectionText={() => undefined}
                    onSubmitCorrection={(event) => event.preventDefault()}
                    onCancelCorrection={() => undefined}
                    onDisable={() => undefined}
                    onForget={() => undefined}
                    onRestore={() =>
                      void runCommand(MEMORY_COMMANDS.restore, { memoryId: row.memoryId })
                    }
                  />
                ))}
              </ul>
            </section>
          )}
          <section className="memory-section" aria-labelledby="memory-activity-heading">
            <div className="memory-section-head">
              <h3 id="memory-activity-heading">记忆动态</h3>
            </div>
            {view.activityEmpty ? (
              <p className="memory-empty">{view.activityEmpty}</p>
            ) : (
              <ul className="memory-list memory-activity-list">
                {view.activity.map((row) => (
                  <li key={row.activityId} className="memory-activity-row">
                    <span className="memory-record-kind">{row.label}</span>
                    <span className="memory-record-summary">{row.summary}</span>
                    <small className="memory-record-meta">{row.timeLabel}</small>
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

function MemoryItem({
  row,
  pending,
  sourceOpen,
  correcting,
  correctionText,
  onToggleSource,
  onEdit,
  onCorrect,
  onCorrectionText,
  onSubmitCorrection,
  onCancelCorrection,
  onDisable,
  onForget,
  onRestore,
}: {
  row: MemoryPanelItem;
  pending: boolean;
  sourceOpen: boolean;
  correcting: boolean;
  correctionText: string;
  onToggleSource: () => void;
  onEdit: () => void;
  onCorrect: () => void;
  onCorrectionText: (value: string) => void;
  onSubmitCorrection: (event: FormEvent<HTMLFormElement>) => void;
  onCancelCorrection: () => void;
  onDisable: () => void;
  onForget: () => void;
  onRestore: () => void;
}) {
  return (
    <li className="memory-record-row">
      <div className="memory-record-copy">
        <span className="memory-record-summary">{row.summary}</span>
        <small className="memory-record-meta">
          {row.scopeLabel} · {row.authorLabel} · {row.mutabilityLabel}
        </small>
        <small className="memory-record-meta">
          状态 {row.statusLabel} · {row.conflictLabel} · 更新 {row.updatedLabel} · 上次召回{" "}
          {row.recalledLabel}
          {row.recallReason ? ` · 召回原因 ${row.recallReason}` : ""}
        </small>
      </div>
      <div className="memory-row-actions">
        {row.editablePreference && (
          <button type="button" className="memory-ghost-button" disabled={pending} onClick={onEdit}>
            编辑
          </button>
        )}
        {row.actions.correct && !row.editablePreference && (
          <button
            type="button"
            className="memory-ghost-button"
            disabled={pending}
            onClick={onCorrect}
          >
            纠正
          </button>
        )}
        {row.actions.disable && (
          <button
            type="button"
            className="memory-ghost-button"
            disabled={pending}
            onClick={onDisable}
          >
            停用
          </button>
        )}
        {row.actions.forget && (
          <button
            type="button"
            className="memory-ghost-button"
            disabled={pending}
            onClick={onForget}
          >
            忘记
          </button>
        )}
        {row.actions.restore && (
          <button
            type="button"
            className="memory-ghost-button"
            disabled={pending}
            onClick={onRestore}
          >
            恢复
          </button>
        )}
        {row.actions.viewSource && (
          <button
            type="button"
            className="memory-ghost-button"
            aria-expanded={sourceOpen}
            disabled={pending}
            onClick={onToggleSource}
          >
            来源
          </button>
        )}
      </div>
      {sourceOpen && (
        <ul className="memory-source-list">
          {row.sourceLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {correcting && (
        <form className="memory-form" onSubmit={onSubmitCorrection}>
          <label className="memory-field" htmlFor={`memory-correct-${row.memoryId}`}>
            <span>纠正内容</span>
            <input
              id={`memory-correct-${row.memoryId}`}
              value={correctionText}
              disabled={pending}
              onChange={(event) => onCorrectionText(event.target.value)}
            />
          </label>
          <div className="memory-form-actions">
            <button
              type="button"
              className="memory-ghost-button"
              disabled={pending}
              onClick={onCancelCorrection}
            >
              取消
            </button>
            <button type="submit" className="client-dark-button" disabled={pending}>
              保存纠正
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
