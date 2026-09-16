import { DismissIcon, MicrophoneIcon, PauseIcon } from "./icons";

export function AssistantSurface() {
  return (
    <main className="assistant-shell" data-tauri-drag-region>
      <div className="assistant-aura" aria-hidden="true">
        <span className="assistant-ring assistant-ring-outer" />
        <span className="assistant-ring assistant-ring-inner" />
        <span className="assistant-core" />
      </div>

      <div className="assistant-copy">
        <span className="assistant-status">待命</span>
        <strong>Semi-OS</strong>
        <span>按住快捷键开始说话</span>
      </div>

      <div className="assistant-actions">
        <button type="button" aria-label="开始说话" title="开始说话">
          <MicrophoneIcon size={17} weight="bold" />
        </button>
        <button type="button" aria-label="暂停任务" title="暂停任务" disabled>
          <PauseIcon size={17} weight="bold" />
        </button>
        <button type="button" aria-label="取消任务" title="取消任务" disabled>
          <DismissIcon size={17} weight="bold" />
        </button>
      </div>
    </main>
  );
}
