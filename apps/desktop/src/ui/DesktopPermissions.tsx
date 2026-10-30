import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { RequestPayloads } from "@semi-os/protocol";
import {
  describePermissionOutcome,
  isRequestable,
  type PermissionRequestOutcome,
} from "./desktop-permission-request";

type Permissions = NonNullable<RequestPayloads["desktop.result"]["permissions"]>;

/** 后端只回传闭集枚举与刷新后的快照；界面不解析系统原始错误。 */
type PermissionRequest = {
  permission: string;
  outcome: PermissionRequestOutcome;
  permissions: Permissions;
};
const labels = [
  ["accessibility", "辅助功能"],
  ["screenRecording", "屏幕录制"],
  ["inputMonitoring", "输入监控"],
  ["microphone", "麦克风"],
] as const;
const statusLabels: Record<string, string> = {
  granted: "已授权",
  denied: "未授权",
  not_determined: "未决定",
  restricted: "受限",
  unavailable: "不可用",
};
const visualStatusLabels: Record<Permissions["visualFallback"]["status"], string> = {
  available: "可用",
  needs_user: "需要确认",
  unavailable: "不可用",
};

/** Web 预览不伪造 OS 权限；只在设置可见期间检查，不自动弹授权框。 */
export function DesktopPermissions() {
  const [permissions, setPermissions] = useState<Permissions>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [requesting, setRequesting] = useState("");
  const [checkingObservation, setCheckingObservation] = useState(false);
  async function checkObservation() {
    setCheckingObservation(true);
    setNotice("");
    try {
      setNotice(await invoke<string>("check_desktop_observation"));
      setError("");
    } catch (cause) {
      setError(
        cause === "桌面任务正在执行，请先暂停后再自检"
          ? cause
          : "桌面自检无法完成，请检查原生客户端",
      );
    } finally {
      setCheckingObservation(false);
    }
  }
  async function refresh(recover = false) {
    if (!isTauri()) return;
    setPending(true);
    try {
      setPermissions(await invoke<Permissions>("get_desktop_permissions", { recover }));
      setError("");
    } catch {
      setError("无法读取原生权限状态");
    } finally {
      setPending(false);
    }
  }
  /**
   * 授权请求只来自这里的一次点击：没有 useEffect 触发，启动时不会弹窗。
   * `requested` 只代表系统已收到请求，界面不替 macOS 宣布用户拒绝。
   */
  async function request(permission: string) {
    if (!isRequestable(permission)) return;
    setRequesting(permission);
    setNotice("");
    try {
      const result = await invoke<PermissionRequest>("request_desktop_permission", {
        permission,
      });
      setPermissions(result.permissions);
      setNotice(describePermissionOutcome(permission, result.outcome));
      setError("");
    } catch {
      setError("无法发起授权请求");
    } finally {
      setRequesting("");
    }
  }
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  if (!isTauri()) return null;
  return (
    <fieldset className="voice-settings desktop-permissions">
      <legend>桌面权限</legend>
      {labels.map(([key, label]) => (
        <div className="desktop-permission-row" key={key}>
          <span>{label}</span>
          <span>{permissions ? statusLabels[permissions[key]] : "检查中"}</span>
          <div className="desktop-permission-actions">
            {isRequestable(key) && (
              <button
                type="button"
                disabled={pending || requesting !== ""}
                onClick={() => void request(key)}
              >
                {requesting === key ? "请求中" : "请求授权"}
              </button>
            )}
            <button
              type="button"
              disabled={requesting !== ""}
              onClick={() =>
                void invoke("open_desktop_permission_settings", { permission: key }).catch(() =>
                  setError("无法打开系统设置"),
                )
              }
            >
              系统设置
            </button>
          </div>
        </div>
      ))}
      <small className="desktop-permission-hint">
        辅助功能用于读取控件，输入监控用于人工接管保护；桌面操作需要两者。
        授权后重新检查，若仍未授权，请确认系统列表中授权的是当前版本并重启应用。
      </small>
      {notice && (
        <p className="desktop-permission-notice" role="status">
          {notice}
        </p>
      )}
      {permissions && (
        <div className="desktop-capability-note" role="status">
          <div>
            <span>视觉回退</span>
            <strong>{visualStatusLabels[permissions.visualFallback.status]}</strong>
          </div>
          <p>{permissions.visualFallback.reason}</p>
          {permissions.screenRecording === "granted" &&
            permissions.visualFallback.status !== "available" && (
              <small>屏幕录制权限不等于视觉定位能力；当前仍只使用 Accessibility 语义观察。</small>
            )}
        </div>
      )}
      {permissions && !permissions.takeoverDetection && (
        <p className="desktop-capability-warning" role="status">
          人工接管监听不可用，桌面变更动作已停用；文字对话和语义观察仍可用。
        </p>
      )}
      <button
        type="button"
        disabled={pending || requesting !== ""}
        onClick={() => void refresh(true)}
      >
        重新检查
      </button>
      <button
        type="button"
        disabled={checkingObservation || pending || requesting !== ""}
        onClick={() => void checkObservation()}
      >
        {checkingObservation ? "自检中" : "只读自检"}
      </button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
