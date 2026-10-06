use semi_os_host::{
    DiagnosticStore, HostLifecycle, HostLifecycleSnapshot, RestartPolicy, WorkerCommand,
    WorkerEvent, WorkerSupervisor, WorkerSupervisorHandle,
};
use semi_os_protocol::{validate_envelope, Envelope};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const CLIENT_WINDOW: &str = "client";
const ASSISTANT_WINDOW: &str = "assistant";
const PUSH_TO_TALK_SHORTCUT: &str = "CommandOrControl+Shift+Space";

struct DesktopState {
    lifecycle: Mutex<HostLifecycle>,
    worker: Mutex<Option<WorkerSupervisorHandle>>,
}

/// 显示指定窗口，并按调用场景决定是否获取焦点。
///
/// 托盘是窗口被隐藏后的恢复入口，因此这里不依赖前端状态；即使 WebView
/// 暂时不可用，用户也能重新打开客户端或助手窗口。桌面助手默认不激活，
/// 避免按住语音快捷键时打断用户正在操作的应用。
fn show_window(app: &tauri::AppHandle, label: &str, focus: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window is unavailable: {label}"))?;
    window.show().map_err(|error| error.to_string())?;
    if focus {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn emit_assistant_visibility(app: &tauri::AppHandle, visible: bool) {
    let _ = app.emit("host://assistant-visibility-changed", visible);
}

fn assistant_visibility(app: &tauri::AppHandle) -> Result<bool, String> {
    app.get_webview_window(ASSISTANT_WINDOW)
        .ok_or_else(|| "assistant window is unavailable".to_owned())?
        .is_visible()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_host_lifecycle(
    state: State<'_, Arc<DesktopState>>,
) -> Result<HostLifecycleSnapshot, String> {
    state
        .lifecycle
        .lock()
        .map(|lifecycle| lifecycle.snapshot())
        .map_err(|_| "host lifecycle lock is unavailable".to_owned())
}

/// 窗口显隐由 Rust Host 执行，React 只表达用户意图，不直接持有窗口权限。
#[tauri::command]
fn set_assistant_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(ASSISTANT_WINDOW)
        .ok_or_else(|| "assistant window is unavailable".to_owned())?;
    if visible {
        window.show().map_err(|error| error.to_string())?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    emit_assistant_visibility(&app, visible);
    Ok(())
}

#[tauri::command]
fn get_assistant_visibility(app: tauri::AppHandle) -> Result<bool, String> {
    assistant_visibility(&app)
}

/// React 只能提交版本化请求；Worker stdin 始终由 Supervisor 串行持有和写入。
#[tauri::command]
fn send_worker_request(
    state: State<'_, Arc<DesktopState>>,
    envelope: Envelope,
) -> Result<(), String> {
    validate_envelope(&envelope).map_err(|error| error.message)?;
    if !matches!(envelope, Envelope::Request { .. }) {
        return Err("only request envelopes can be sent to the worker".to_owned());
    }
    state
        .worker
        .lock()
        .map_err(|_| "worker supervisor lock is unavailable".to_owned())?
        .as_ref()
        .ok_or_else(|| "worker supervisor is unavailable".to_owned())?
        .send(envelope)
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn start_worker(app: &tauri::AppHandle) -> Result<WorkerSupervisorHandle, String> {
    let repository_root = repository_root();
    let diagnostics_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("diagnostics/worker.jsonl");
    let app_handle = app.clone();
    let message_app_handle = app.clone();
    let supervisor = WorkerSupervisor::new(
        WorkerCommand {
            program: "node".to_owned(),
            args: vec![
                "--experimental-strip-types".to_owned(),
                // 密钥由 Node 原生 dotenv 加载，避免经过 React、Tauri IPC 或
                // 命令行参数；.env 已被 Git 忽略，仅提交 .env.example。
                "--env-file-if-exists=.env".to_owned(),
                "packages/agent-worker/src/index.ts".to_owned(),
            ],
            current_dir: repository_root,
        },
        RestartPolicy::default(),
        Arc::new(DiagnosticStore::new(diagnostics_path)),
        Arc::new(move |event: WorkerEvent| {
            // UI 只接收 WorkerEvent 中经过约束的字段，不转发 stderr 或环境变量。
            let _ = app_handle.emit("host://worker-event", event);
        }),
        Arc::new(move |message| {
            // 所有消息已经在 Supervisor 中完成版本和 Envelope 校验；UI 仍需按
            // kind 解析领域载荷，不能把任意 Worker JSON 当作可信 DOM 内容。
            let _ = message_app_handle.emit("host://worker-message", message);
        }),
    );
    Ok(supervisor.start())
}

fn shutdown(state: &Arc<DesktopState>) {
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        lifecycle.mark_shutting_down();
    }
    if let Ok(mut worker) = state.worker.lock() {
        if let Some(mut handle) = worker.take() {
            handle.stop();
        }
    }
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        lifecycle.mark_stopped();
    }
}

fn main() {
    let state = Arc::new(DesktopState {
        lifecycle: Mutex::new(HostLifecycle::default()),
        worker: Mutex::new(None),
    });

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| match event.state() {
                    ShortcutState::Pressed => {
                        if show_window(app, ASSISTANT_WINDOW, false).is_ok() {
                            emit_assistant_visibility(app, true);
                        }
                        let _ = app.emit("host://push-to-talk-pressed", ());
                    }
                    ShortcutState::Released => {
                        let _ = app.emit("host://push-to-talk-released", ());
                    }
                })
                .build(),
        )
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![
            get_host_lifecycle,
            get_assistant_visibility,
            set_assistant_visible,
            send_worker_request
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 常驻桌面应用把系统关闭按钮解释为隐藏；只有托盘“退出”
                // 才结束 Host 和 Worker，保证窗口始终可由托盘重新唤回。
                api.prevent_close();
                let _ = window.hide();
                if window.label() == ASSISTANT_WINDOW {
                    emit_assistant_visibility(window.app_handle(), false);
                }
            }
        })
        .setup(|app| {
            let show_client =
                MenuItem::with_id(app, "show_client", "打开客户端", true, None::<&str>)?;
            let show_assistant =
                MenuItem::with_id(app, "show_assistant", "显示桌面助手", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Semi-OS", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_client, &show_assistant, &quit])?;

            // MVP 阶段使用文字托盘入口，后续品牌资产确定后再替换模板图标。
            TrayIconBuilder::with_id("semi-os")
                .title("Semi-OS")
                .tooltip("Semi-OS 桌面助手")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_client" => {
                        let _ = show_window(app, CLIENT_WINDOW, true);
                    }
                    "show_assistant" => {
                        if show_window(app, ASSISTANT_WINDOW, false).is_ok() {
                            emit_assistant_visibility(app, true);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            app.global_shortcut().register(PUSH_TO_TALK_SHORTCUT)?;
            let desktop_state = app.state::<Arc<DesktopState>>();
            let worker = start_worker(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
            desktop_state
                .worker
                .lock()
                .map_err(|_| "worker supervisor lock is unavailable")?
                .replace(worker);
            desktop_state
                .lifecycle
                .lock()
                .map_err(|_| "host lifecycle lock is unavailable")?
                .mark_ready(true);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Semi-OS desktop shell");

    app.run(move |_app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            shutdown(&state);
        }
    });
}
