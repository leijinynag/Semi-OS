import { HaloScene } from "./HaloScene";
import { assistantVoice } from "../voice/controller";

/** 动画只是透明呈现层；录音和播放的生命周期不依赖 React 挂载。 */
export function AssistantSurface() {
  return (
    <main className="assistant-shell" aria-label="Semi-OS 桌面助手">
      <div className="assistant-halo" aria-hidden="true">
        <HaloScene mode="idle" audioLevel={assistantVoice.audioLevel} />
      </div>
    </main>
  );
}
