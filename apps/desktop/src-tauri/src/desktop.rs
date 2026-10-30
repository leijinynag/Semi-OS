//! 原生入口只接客户端用户意图；驱动、目标校验及验证由 Host 服务执行。
use super::*;
use semi_os_host::desktop::DesktopService;
use semi_os_host::desktop_macos::{
    request_permission, MacDesktop, PermissionKind, PermissionRequestOutcome,
};
use semi_os_protocol::messages::{
    PayloadDesktopObservation, PayloadDesktopPermissions, PayloadDesktopResult,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

pub type NativeService = DesktopService<MacDesktop>;

/// 客户端只消费这个脱敏快照，不直接读取 Host 服务或原生句柄。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUiState {
    pub operation_id: Option<String>,
    pub task_id: Option<String>,
    pub status: String,
    pub summary: String,
    pub lease_generation: u64,
    pub permissions: Option<PayloadDesktopPermissions>,
    pub observation: Option<PayloadDesktopObservation>,
    pub evidence: Option<String>,
    pub recovery_stage: String,
    pub updated_at_ms: u64,
}

impl DesktopUiState {
    fn from_result(
        operation_id: Option<String>,
        task_id: Option<String>,
        result: &PayloadDesktopResult,
        permissions: Option<PayloadDesktopPermissions>,
        now: u64,
    ) -> Self {
        Self {
            operation_id,
            task_id,
            status: result.status.clone(),
            summary: result.summary.clone(),
            lease_generation: result.lease_generation,
            permissions,
            observation: result.observation.as_ref().map(sanitize_observation),
            evidence: result.evidence.clone(),
            recovery_stage: match result.status.as_str() {
                "observed" => "observed",
                "verified" => "verified",
                "unknown" => "reconcile_required",
                "needs_user" => "waiting_for_user",
                "failure" => "failed",
                _ => "idle",
            }
            .into(),
            updated_at_ms: now,
        }
    }
}

/// UI 只需要窗口和控件数量等上下文，不需要再次暴露完整控件值。
/// Host 返回给 Worker 的协议结果仍保留其既定语义；这里是展示层的第二道脱敏边界。
fn sanitize_observation(observation: &PayloadDesktopObservation) -> PayloadDesktopObservation {
    let mut sanitized = observation.clone();
    for element in &mut sanitized.elements {
        element.value = None;
        element.value_truncated = false;
    }
    sanitized
}

pub fn service() -> NativeService {
    DesktopService::new(
        MacDesktop::default(),
        format!("boot-{}-{}", std::process::id(), unix_time_ms()),
    )
}

/// 打包验收的只读入口：直接使用当前 bundle 的进程身份，不启动模型、录音或动作。
/// 仅输出权限、应用身份和控件数量，便于区分 TCC 问题与目标应用 AX 问题。
pub fn diagnostic() -> serde_json::Value {
    let mut service = service();
    let now = unix_time_ms() as u64;
    let permissions = service.recheck_permissions_by_user(now);
    let result = service.execute(
        "desktop-diagnostic",
        &semi_os_host::desktop_macos::DesktopAction::Observe,
        None,
        now,
    );
    json!({
        "permissions": permissions,
        "status": result.status,
        "summary": result.summary,
        "application": result.observation.as_ref().map(|o| &o.bundle_id),
        "elementCount": result.observation.as_ref().map(|o| o.elements.len()),
        "truncated": result.observation.as_ref().map(|o| o.truncated),
    })
}

/// 取消不能撤销已进入系统的动作；只阻止旧租约继续派发。
pub fn interrupt(state: &DesktopState) {
    if let Ok(mut service) = state.desktop.lock() {
        if service.owner().is_some() {
            service.pause();
        }
    }
}

/// 桌面操作不经通用 UI 消息广播，避免 AX 控件内容进入普通日志/事件。
pub fn handle_message(app: &tauri::AppHandle, message: &Envelope) -> Result<bool, String> {
    let Envelope::Event {
        kind,
        payload,
        request_id,
        ..
    } = message
    else {
        return Ok(false);
    };
    if kind != "desktop.request" && kind != "desktop.cancelled" {
        return Ok(false);
    }
    let state = app.state::<Arc<DesktopState>>();
    if kind == "desktop.cancelled" {
        let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
        let mut cancelled = false;
        if let (Some(task), Some(operation)) =
            (payload["taskId"].as_str(), payload["operationId"].as_str())
        {
            cancelled = service.cancel_operation(task, operation);
        }
        drop(service);
        if cancelled {
            publish_control_state(
                app,
                &state,
                payload["operationId"].as_str(),
                payload["taskId"].as_str(),
                "桌面请求已取消；若动作可能已经进入系统，请先重新观察核对",
                unix_time_ms() as u64,
            )?;
        }
        return Ok(true);
    }
    let (result, permissions) = {
        // 所有桌面入口固定 storage -> desktop 锁顺序，不在持锁时向 Worker 发消息。
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
        let result =
            semi_os_host::desktop_router::dispatch(storage, &mut service, message, unix_time_ms())
                .unwrap_or_else(|error| semi_os_protocol::messages::PayloadDesktopResult {
                    status: "needs_user".into(),
                    summary: error.ui_message().into(),
                    lease_generation: 0,
                    observation: None,
                    evidence: None,
                });
        let permissions = service.permissions(unix_time_ms() as u64);
        (result, permissions)
    };
    let operation_id = payload["operationId"].as_str().map(str::to_owned);
    let task_id = payload["taskId"].as_str().map(str::to_owned);
    publish_result_state(
        app,
        &state,
        operation_id,
        task_id,
        &result,
        Some(permissions),
        unix_time_ms() as u64,
    )?;
    state
        .worker
        .lock()
        .map_err(|_| "worker unavailable")?
        .as_ref()
        .ok_or("worker unavailable")?
        .send(Envelope::Request {
            protocol_version: 1,
            request_id: request_id.clone(),
            kind: "desktop.result".into(),
            payload: json!({"operationId":payload["operationId"],"result":result}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        })?;
    Ok(true)
}

fn publish_result_state(
    app: &tauri::AppHandle,
    state: &Arc<DesktopState>,
    operation_id: Option<String>,
    task_id: Option<String>,
    result: &PayloadDesktopResult,
    permissions: Option<PayloadDesktopPermissions>,
    now: u64,
) -> Result<(), String> {
    let snapshot = DesktopUiState::from_result(operation_id, task_id, result, permissions, now);
    {
        let mut latest = state
            .desktop_snapshot
            .lock()
            .map_err(|_| "desktop state unavailable")?;
        *latest = Some(snapshot.clone());
    }
    app.emit("host://desktop-state", snapshot)
        .map_err(|_| "desktop state unavailable".to_owned())
}

fn publish_control_state(
    app: &tauri::AppHandle,
    state: &Arc<DesktopState>,
    operation_id: Option<&str>,
    task_id: Option<&str>,
    summary: &str,
    now: u64,
) -> Result<(), String> {
    let (permissions, lease_generation) = {
        let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
        let permissions = service.permissions(now);
        (permissions, service.lease_generation())
    };
    let previous = state
        .desktop_snapshot
        .lock()
        .map_err(|_| "desktop state unavailable")?
        .clone();
    let result = PayloadDesktopResult {
        status: "needs_user".into(),
        summary: summary.into(),
        lease_generation,
        observation: None,
        evidence: None,
    };
    publish_result_state(
        app,
        state,
        operation_id.map(str::to_owned).or_else(|| {
            previous
                .as_ref()
                .and_then(|value| value.operation_id.clone())
        }),
        task_id
            .map(str::to_owned)
            .or_else(|| previous.as_ref().and_then(|value| value.task_id.clone())),
        &result,
        Some(permissions),
        now,
    )
}

#[tauri::command]
pub async fn get_desktop_permissions(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    recover: Option<bool>,
) -> Result<PayloadDesktopPermissions, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("权限检查仅允许客户端请求".into());
    }
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
        let now = unix_time_ms() as u64;
        // 挂载和焦点刷新只查状态；失效监听只能由用户明确点击后恢复。
        Ok(if recover == Some(true) {
            service.recheck_permissions_by_user(now)
        } else {
            service.permissions(now)
        })
    })
    .await
    .map_err(|_| "权限检查无法完成".to_owned())?
}

/// 只读自检不依赖 Worker、模型或语音。无论窗口是否支持 AX，都返回真实原因；
/// 不自动弹授权框、不启动应用、不把窗口正文写进诊断或客户端快照。
#[tauri::command]
pub async fn check_desktop_observation(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
) -> Result<String, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("桌面自检仅允许客户端请求".into());
    }
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
        // 自检也不能覆盖正在进行的任务的原生目标句柄。
        if service.owner().is_some() {
            return Err("桌面任务正在执行，请先暂停后再自检".into());
        }
        let result = service.execute(
            "desktop-diagnostic",
            &semi_os_host::desktop_macos::DesktopAction::Observe,
            None,
            unix_time_ms() as u64,
        );
        Ok(match result.observation {
            Some(observation) => format!(
                "辅助功能观察正常：{}，读取到 {} 个语义控件{}",
                observation.bundle_id,
                observation.elements.len(),
                if observation.truncated {
                    "（已截断）"
                } else {
                    ""
                }
            ),
            None => result.summary,
        })
    })
    .await
    .map_err(|_| "桌面自检无法完成".to_owned())?
}

/// 授权请求结果：只回传闭集枚举与刷新后的权限快照，
/// 不回传系统原始错误，也不把「未授权」伪装成“用户拒绝”。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPermissionRequest {
    pub permission: String,
    /// `granted` 或 `requested`。
    pub outcome: String,
    pub permissions: PayloadDesktopPermissions,
}

/// 只由客户端「请求授权」按钮触发。
///
/// 必须是 async 命令：`CGRequestListenEventAccess` 与 `CGRequestScreenCaptureAccess`
/// 会阻塞到用户在系统弹窗里作答，同步命令会卡住主线程。阻塞调用期间也不持
/// 桌面锁，否则一个未决弹窗会挡住其他桌面检查。
#[tauri::command]
pub async fn request_desktop_permission(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    permission: String,
) -> Result<DesktopPermissionRequest, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("授权请求仅允许客户端发起".into());
    }
    // 闭集校验：只接受列出的四项权限，未知名字不会走到系统弹窗。
    let kind = PermissionKind::parse(&permission).ok_or("该权限不支持程序化请求")?;
    let outcome = tauri::async_runtime::spawn_blocking(move || request_permission(kind))
        .await
        .map_err(|_| "授权请求无法完成")?
        .map_err(|error| error.to_string())?;
    let granted = matches!(outcome, PermissionRequestOutcome::Granted);
    let permissions = state
        .desktop
        .lock()
        .map_err(|_| "desktop unavailable")?
        .apply_permission_change(granted, unix_time_ms() as u64);
    Ok(DesktopPermissionRequest {
        permission,
        outcome: outcome.as_str().into(),
        permissions,
    })
}

#[tauri::command]
pub fn get_desktop_state(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
) -> Result<Option<DesktopUiState>, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("桌面状态仅允许客户端请求".into());
    }
    state
        .desktop_snapshot
        .lock()
        .map_err(|_| "desktop state unavailable".into())
        .map(|snapshot| snapshot.clone())
}

#[tauri::command]
pub fn open_desktop_permission_settings(
    window: tauri::WebviewWindow,
    permission: String,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW {
        return Err("仅允许客户端打开权限设置".into());
    }
    let pane = match permission.as_str() {
        "accessibility" => "Privacy_Accessibility",
        "screenRecording" => "Privacy_ScreenCapture",
        "microphone" => "Privacy_Microphone",
        "inputMonitoring" => "Privacy_ListenEvent",
        _ => return Err("未知权限".into()),
    };
    // 固定应用、固定参数白名单，不接受 URL/shell/脚本。
    let status = std::process::Command::new("/usr/bin/open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{pane}"
        ))
        .status()
        .map_err(|_| "无法打开系统设置")?;
    if status.success() {
        Ok(())
    } else {
        Err("无法打开系统设置".into())
    }
}

#[tauri::command]
pub fn control_desktop(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    action: String,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW {
        return Err("仅允许客户端控制桌面租约".into());
    }
    let mut service = state.desktop.lock().map_err(|_| "desktop unavailable")?;
    match action.as_str() {
        "pause" | "cancel" => service.pause(),
        "resume" | "recheck" => service.resume_by_user(),
        _ => return Err("未知桌面控制".into()),
    }
    drop(service);
    publish_control_state(
        window.app_handle(),
        &state,
        None,
        None,
        match action.as_str() {
            "resume" | "recheck" => "已解除暂停；请重新观察桌面目标",
            "cancel" => "桌面任务已取消；可能已进入系统的动作需要人工核对",
            _ => "桌面任务已暂停，新的动作不会继续派发",
        },
        unix_time_ms() as u64,
    )
}
