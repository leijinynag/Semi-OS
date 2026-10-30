import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./styles.css";
import { initializeAssistantVoice } from "./voice/controller";

document.documentElement.dataset.surface =
  new URLSearchParams(location.search).get("surface") ?? "client";

if (
  new URLSearchParams(location.search).get("surface") === "assistant" &&
  "__TAURI_INTERNALS__" in window
) {
  void initializeAssistantVoice().catch((error: unknown) =>
    console.error("语音控制器初始化失败", error),
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Desktop root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
