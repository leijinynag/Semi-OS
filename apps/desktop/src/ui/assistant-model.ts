/**
 * 桌面助手的展示状态。
 *
 * 该类型只描述 Halo 的视觉状态，不承担任务语义；任务进度和确认状态
 * 仍由 Host 通过结构化事件提供给客户端。
 */
export type AssistantMode =
  "idle" | "listening" | "working" | "waiting_confirmation" | "paused" | "cancelled";
