/**
 * 桌面权限授权请求的纯逻辑边界。
 *
 * 只有这里列出的权限允许程序化请求，与 Rust 侧 `PermissionKind` 的闭集一致。
 * 麦克风也在此列：TCC 只把真正发起过请求的进程列为可授权项，没有请求入口时
 * 用户会卡在「系统设置里根本找不到这个应用」。
 */
export const REQUESTABLE_PERMISSIONS = [
  "accessibility",
  "screenRecording",
  "inputMonitoring",
  "microphone",
] as const;

export type RequestablePermission = (typeof REQUESTABLE_PERMISSIONS)[number];

/**
 * `requested` 表示已向系统发起请求但当前仍未授权。
 * macOS 不暴露“用户点了拒绝”还是“系统抑制了弹窗”，因此界面不得替系统宣布拒绝。
 */
export type PermissionRequestOutcome = "granted" | "requested";

export function isRequestable(permission: string): permission is RequestablePermission {
  return (REQUESTABLE_PERMISSIONS as readonly string[]).includes(permission);
}

const messages: Record<RequestablePermission, Record<PermissionRequestOutcome, string>> = {
  accessibility: {
    granted: "已获得辅助功能授权，可以开始观察桌面",
    requested: "已发起辅助功能授权请求；若未看到系统弹窗，请在系统设置中手动勾选 Semi-OS",
  },
  screenRecording: {
    granted: "已获得屏幕录制授权；若未生效请重启应用",
    requested: "已发起屏幕录制授权请求；若未看到系统弹窗，请在系统设置中手动勾选 Semi-OS",
  },
  inputMonitoring: {
    granted: "已获得输入监控授权，人工接管监听已启用",
    requested: "已发起输入监控授权请求；若未看到系统弹窗，请在系统设置中手动勾选 Semi-OS",
  },
  microphone: {
    granted: "已获得麦克风授权，语音输入已可用",
    // 麦克风的未决与拒绝在 TCC 里无法区分；两者都只能靠手动勾选解决。
    requested: "已发起麦克风授权请求；若未看到系统弹窗，请在系统设置的麦克风中勾选 Semi-OS",
  },
};

export function describePermissionOutcome(
  permission: RequestablePermission,
  outcome: PermissionRequestOutcome,
): string {
  return messages[permission][outcome];
}
