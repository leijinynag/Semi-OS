import { getCurrentWindow } from "@tauri-apps/api/window";
import { AssistantSurface } from "./AssistantSurface";
import { ClientSurface } from "./ClientSurface";
import { lazy, Suspense } from "react";

const ExecutionPreview = lazy(() => import("./ExecutionPreview"));

export type DesktopSurface = "client" | "assistant";

/**
 * Tauri 生产环境以窗口 label 作为唯一身份；浏览器开发环境可通过 query 参数
 * 预览两种界面，避免 UI 开发必须每次启动完整桌面进程。
 */
function resolveSurface(): DesktopSurface {
  const preview = new URLSearchParams(window.location.search).get("surface");
  if (preview === "assistant") {
    return "assistant";
  }

  try {
    return getCurrentWindow().label === "assistant" ? "assistant" : "client";
  } catch {
    return "client";
  }
}

export function App() {
  const surface = resolveSurface();
  document.documentElement.dataset.surface = surface;

  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("preview") === "execution"
  ) {
    return (
      <Suspense fallback={null}>
        <ExecutionPreview />
      </Suspense>
    );
  }
  return surface === "assistant" ? <AssistantSurface /> : <ClientSurface />;
}
