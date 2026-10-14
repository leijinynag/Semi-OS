use semi_os_host::conversation::Conversation;
use semi_os_host::{
    route_lifecycle, DiagnosticRecord, DiagnosticStore, HostLifecycle, HostLifecycleSnapshot,
    LifecycleCommand, RestartPolicy, WorkerCommand, WorkerEvent, WorkerSupervisor,
    WorkerSupervisorHandle, WorkflowControlAction, WorkflowControlRequest,
    WorkflowQuestionAnswerRequest, WorkflowRequirementChangeRequest, WorkflowUserDecision,
    WorkflowUserDecisionRequest,
};
use semi_os_protocol::{validate_envelope, Envelope, EnvelopeContext, RequestId};
use semi_os_storage::{ClientSession, Storage, WorkflowSnapshotDto};
use serde_json::{json, Value};
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
mod router;
use router::{handle_research_message, handle_workflow_message};
mod text_input;
mod voice_settings;
use voice_settings::VoiceSettings;

const CLIENT_WINDOW: &str = "client";
const ASSISTANT_WINDOW: &str = "assistant";
const PUSH_TO_TALK_SHORTCUT: &str = "CommandOrControl+Shift+Space";
static TEXT_INPUT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 仅接受已知阶段与有限数值；不允许 WebView 借诊断接口保存任意正文。
#[tauri::command]
fn record_voice_timing(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    stage: String,
    duration_ms: f64,
) -> Result<(), String> {
    if window.label() != ASSISTANT_WINDOW
        || request_id.len() > 128
        || !request_id.starts_with("req_")
        || !voice_settings::valid_timing(&stage, duration_ms)
    {
        return Err("invalid voice timing".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "data directory unavailable")?
        .join("diagnostics/voice-timing.jsonl");
    DiagnosticStore::new(path)
        .append(&DiagnosticRecord::now(
            "voice_timing",
            stage,
            0,
            json!({"requestId":request_id,"durationMs":duration_ms}),
        ))
        .map_err(|_| "cannot save voice timing".into())
}

/// 仅保存播放链路的数值诊断，不保存声音、转写、正文或 Provider 数据。
#[tauri::command]
fn record_voice_playback(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    stage: String,
    metrics: Value,
) -> Result<(), String> {
    if window.label() != ASSISTANT_WINDOW
        || request_id.len() > 128
        || !request_id.starts_with("req_")
        || ![
            "audio_received",
            "playing",
            "buffering",
            "paused",
            "ended",
            "failed",
        ]
        .contains(&stage.as_str())
    {
        return Err("invalid playback diagnostic".into());
    }
    let values = metrics.as_object().ok_or("invalid playback metrics")?;
    if values.len() > 6
        || values.iter().any(|(key, value)| {
            ![
                "bytes",
                "positionMs",
                "contextTime",
                "contextRunning",
                "level",
            ]
            .contains(&key.as_str())
                || value
                    .as_f64()
                    .is_none_or(|number| !number.is_finite() || number < 0.0)
        })
    {
        return Err("invalid playback metrics".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("diagnostics/playback.jsonl");
    DiagnosticStore::new(path)
        .append(&DiagnosticRecord::now(
            "voice_playback",
            stage,
            0,
            json!({"requestId":request_id,"metrics":metrics}),
        ))
        .map_err(|error| error.to_string())
}

struct DesktopState {
    lifecycle: Mutex<HostLifecycle>,
    worker: Mutex<Option<WorkerSupervisorHandle>>,
    storage: Mutex<Option<Storage>>,
    confirmations: Mutex<std::collections::HashMap<String, Envelope>>,
    conversation: Mutex<Option<Conversation>>,
    voice_settings: Mutex<VoiceSettings>,
    text_input: Mutex<text_input::TextInputRelay>,
    workflow_notices: Mutex<std::collections::HashMap<String, String>>,
}

/// 只在完成或需用户处理发生变化时通知；后台协调不接语音播放器。
fn publish_workflow(app: &tauri::AppHandle, snapshot: &WorkflowSnapshotDto) -> Result<(), String> {
    app.emit("host://workflow", snapshot)
        .map_err(|e| e.to_string())?;
    let state = app.state::<Arc<DesktopState>>();
    let id = snapshot.plan.workflow_id.as_str();
    let execution = snapshot.background.coordinator.execution_status.as_str();
    let mut notices = state
        .workflow_notices
        .lock()
        .map_err(|_| "notification state unavailable")?;
    if !["completed", "needs_user"].contains(&execution) {
        notices.remove(id);
        if notices.is_empty() {
            if let Some(tray) = app.tray_by_id("semi-os") {
                let _ = tray.set_title(Some("Semi-OS"));
                let _ = tray.set_tooltip(Some("Semi-OS 桌面助手"));
            }
        }
        return Ok(());
    }
    let key = format!(
        "{}:{}:{}",
        snapshot.plan.intent_version,
        execution,
        snapshot
            .background
            .coordinator
            .reason
            .as_deref()
            .unwrap_or("")
    );
    if notices.get(id) == Some(&key) {
        return Ok(());
    }
    notices.insert(id.into(), key);
    let title = snapshot.plan.title.as_str();
    let summary = if execution == "completed" {
        "成果已验证"
    } else {
        "需要处理"
    };
    if let Some(tray) = app.tray_by_id("semi-os") {
        let _ = tray.set_title(Some(if execution == "completed" {
            "Semi-OS ✓"
        } else {
            "Semi-OS !"
        }));
        let _ = tray.set_tooltip(Some(format!("{title} · {summary}")));
    }
    app.emit(
        "host://workflow-notice",
        &json!({"workflowId":id,"title":title,"status":execution,"summary":summary}),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn register_text_input_controller(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
) -> Result<(), String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant owns text dispatch".into());
    }
    state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .ready();
    Ok(())
}

/// 文字经 Host 定向交给已有语音控制器；绝不在客户端创建播放器或 Pi 会话。
#[tauri::command]
async fn submit_text_message(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    text: String,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may submit text".into());
    }
    text_input::validate_text(&text)?;
    let id = format!(
        "text_{}",
        TEXT_INPUT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let reply = state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .begin(id.clone())?;
    if app
        .emit_to(
            ASSISTANT_WINDOW,
            "host://text-input",
            json!({"id": id, "text": text}),
        )
        .is_err()
    {
        state
            .text_input
            .lock()
            .map_err(|_| "text relay unavailable")?
            .remove(&id);
        return Err("无法连接助手窗口".into());
    }
    // 不在 UI 主线程等回执。超时不自动重试，避免重复执行有副作用的任务。
    let result = tauri::async_runtime::spawn_blocking(move || {
        reply
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap_or_else(|_| Err("提交状态未知，请先查看对话记录，不要重复发送".into()))
    })
    .await
    .map_err(|_| "text dispatch unavailable".to_owned())?;
    state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .remove(&id);
    result
}

#[tauri::command]
fn get_client_sessions(state: State<'_, Arc<DesktopState>>) -> Result<Vec<ClientSession>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_client_sessions()
        .map_err(|error| error.to_string())
}

/// 新建/切换与文字提交共用接收回执，避免切换途中把消息发送到旧会话。
/// Host 只在助手停止旧录音和播报后提交 active 选择，不以 UI 点击作为已完成。
#[tauri::command]
async fn change_client_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    session_id: Option<String>,
    title: Option<String>,
    delete_session_id: Option<String>,
) -> Result<Vec<ClientSession>, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may change sessions".into());
    }
    if delete_session_id.is_some() && (session_id.is_some() || title.is_some()) {
        return Err("删除不能同时指定新建或切换目标".into());
    }
    let sequence = TEXT_INPUT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("session_change_{sequence}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "clock unavailable")?
        .as_millis() as i64;
    let reply = state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .begin(id.clone())?;
    let prepare: Result<bool, String> = (|| {
        // 与激活回执统一 relay → storage 锁序，迟到回执不能与准备事务互锁。
        let mut relay = state
            .text_input
            .lock()
            .map_err(|_| "text relay unavailable")?;
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let sessions = storage
            .load_client_sessions()
            .map_err(|error| error.to_string())?;
        // 非当前会话无需打断用户正在进行的对话；与提交共用 relay 锁定操作入口。
        if let Some(deleting) = delete_session_id.as_deref() {
            let item = sessions
                .iter()
                .find(|session| session.session_id == deleting)
                .ok_or("会话不存在")?;
            if !item.active {
                storage
                    .delete_client_session(deleting)
                    .map_err(|error| error.to_string())?;
                if dispose_worker_session(&state, &id, deleting).is_err() {
                    let _ = app.emit(
                        "host://research-error",
                        "会话已删除，后台上下文清理失败，请重启客户端",
                    );
                }
                return Ok(false);
            }
        }
        let creating = session_id.is_none() && delete_session_id.is_none();
        let target = if let Some(deleting) = delete_session_id.as_deref() {
            sessions
                .iter()
                .find(|session| session.session_id != deleting)
                .map(|session| session.session_id.clone())
                .unwrap_or_else(|| format!("session_{}_{now}_{sequence}", std::process::id()))
        } else {
            session_id
                .clone()
                .unwrap_or_else(|| format!("session_{}_{now}_{sequence}", std::process::id()))
        };
        if !sessions.iter().any(|session| session.session_id == target) {
            // 客户端传入的任意 ID 不能隐式新建；只允许 Host 生成的身份。
            if !creating && delete_session_id.is_none() {
                return Err("会话不存在".into());
            }
            storage
                .create_client_session(
                    &target,
                    if creating {
                        title.as_deref().ok_or("请输入会话名称")?
                    } else {
                        "新会话"
                    },
                    now,
                )
                .map_err(|error| error.to_string())?;
        }
        relay.bind_session_change(
            &id,
            text_input::SessionChange {
                target: target.clone(),
                deleting: delete_session_id.clone(),
            },
        )?;
        app.emit_to(
            ASSISTANT_WINDOW,
            "host://session-input",
            json!({"id":id,"sessionId":target}),
        )
        .map_err(|_| "无法连接助手窗口".to_owned())?;
        Ok(true)
    })();
    if !matches!(prepare, Ok(true)) {
        state
            .text_input
            .lock()
            .map_err(|_| "text relay unavailable")?
            .remove(&id);
        prepare?;
        let sessions = get_client_sessions(state)?;
        let _ = app.emit("host://client-sessions", &sessions);
        return Ok(sessions);
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        reply
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap_or_else(|_| Err("会话切换状态未知，请查看会话列表".into()))
    })
    .await
    .map_err(|_| "session dispatch unavailable".to_owned())?;
    state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .remove(&id);
    result?;
    get_client_sessions(state)
}

#[tauri::command]
fn activate_client_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    id: String,
    session_id: String,
) -> Result<String, String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant may complete a session change".into());
    }
    // 回执过期后不得再改变选择；校验与事务之间持有 relay 锁，防止超时清理竞争。
    let relay = state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?;
    let change = relay.session_change(&id, &session_id)?;
    // 持锁顺序与 start_voice_conversation 一致；换身份后旧快照校验必然失败。
    let mut current = state
        .conversation
        .lock()
        .map_err(|_| "conversation unavailable")?;
    if let Some(value) = current.as_ref() {
        save_voice_conversation(&state, value)?;
    }
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_mut()
        .ok_or("storage unavailable")?
        .activate_and_delete_client_session(&session_id, change.deleting.as_deref())
        .map_err(|error| error.to_string())?;
    *current = None;
    if let Some(deleting) = change.deleting.as_deref() {
        // 数据库已提交，不得因 Worker 离线把成功删除伪装为切换失败。
        if dispose_worker_session(&state, &id, deleting).is_err() {
            let _ = app.emit(
                "host://research-error",
                "会话已删除，后台上下文清理失败，请重启客户端",
            );
        }
    }
    drop(current);
    drop(relay);
    let sessions = get_client_sessions(state)?;
    let _ = app.emit("host://client-sessions", sessions);
    Ok(session_id)
}

/// 会话上下文只由 Worker 持有；Host 清理通过已串行化的协议，不能直接触碰 Pi。
fn dispose_worker_session(state: &DesktopState, id: &str, session_id: &str) -> Result<(), String> {
    state
        .worker
        .lock()
        .map_err(|_| "worker unavailable")?
        .as_ref()
        .ok_or("worker unavailable")?
        .send(Envelope::Request {
            protocol_version: 1,
            request_id: RequestId(format!("req_dispose_{id}")),
            kind: "voice.session.dispose".into(),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
            payload: json!({"sessionId":session_id}),
        })
}

#[tauri::command]
fn rename_client_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    session_id: String,
    title: String,
) -> Result<Vec<ClientSession>, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may rename sessions".into());
    }
    let id = format!(
        "session_rename_{}",
        TEXT_INPUT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut relay = state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?;
    let _reply = relay.begin(id.clone())?;
    let result = (|| {
        state
            .storage
            .lock()
            .map_err(|_| "storage unavailable")?
            .as_mut()
            .ok_or("storage unavailable")?
            .rename_client_session(&session_id, &title)
            .map_err(|error| error.to_string())?;
        get_client_sessions(state.clone())
    })();
    relay.remove(&id);
    let sessions = result?;
    let _ = app.emit("host://client-sessions", &sessions);
    Ok(sessions)
}

#[tauri::command]
fn acknowledge_text_message(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    id: String,
    accepted: bool,
) -> Result<(), String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant may acknowledge text".into());
    }
    state
        .text_input
        .lock()
        .map_err(|_| "text relay unavailable")?
        .finish(&id, accepted)
}

#[tauri::command]
fn get_voice_settings(state: State<'_, Arc<DesktopState>>) -> Result<VoiceSettings, String> {
    state
        .voice_settings
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "settings unavailable".into())
}

#[tauri::command]
fn set_voice_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    settings: VoiceSettings,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may change voice settings".into());
    }
    let mut value = state
        .voice_settings
        .lock()
        .map_err(|_| "settings unavailable")?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "data directory unavailable")?
        .join("voice-settings.json");
    voice_settings::save(&path, &settings)?;
    *value = settings.clone();
    app.emit("host://voice-settings", settings)
        .map_err(|_| "settings notification failed".into())
}

/// 产品会话与开发仓库分离；仅返回 Host 创建的应用数据工作目录。
#[tauri::command]
fn get_agent_workspace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant owns the voice workspace".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "data directory unavailable")?
        .join("agent-workspace");
    std::fs::create_dir_all(&path).map_err(|_| "cannot create agent workspace")?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn start_voice_conversation(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request_id: String,
    session_id: String,
    task_id: String,
) -> Result<String, String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant owns voice capture".into());
    }
    let mut current = state
        .conversation
        .lock()
        .map_err(|_| "conversation unavailable")?;
    // 忽略 WebView 的旧身份：当前 Session 是 Host 的持久化选择，页面重载不会重建它。
    let _ = session_id;
    let active = get_client_sessions(state.clone())?
        .into_iter()
        .find(|session| session.active)
        .ok_or("no active session")?;
    let value = Conversation::start_turn(None, request_id, active.session_id, task_id)?;
    let session_id = value.session_id.clone();
    current.replace(value);
    // 先把 Host 权威会话 ID 返回录音控制器，再允许其发送 voice.turn.start。
    Ok(session_id)
}

#[tauri::command]
fn publish_voice_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    snapshot: Conversation,
) -> Result<(), String> {
    if window.label() != ASSISTANT_WINDOW {
        return Err("only the assistant owns playback".into());
    }
    snapshot.validate()?;
    let (value, new_error) = {
        let mut guard = state
            .conversation
            .lock()
            .map_err(|_| "conversation unavailable")?;
        let current = guard.as_mut().ok_or("no voice turn")?;
        if snapshot.request_id != current.request_id
            || snapshot.session_id != current.session_id
            || snapshot.task_id != current.task_id
        {
            return Err("stale voice snapshot".into());
        }
        let new_error = snapshot.error.is_some() && snapshot.error != current.error;
        current.state = if current.error.is_some() || snapshot.error.is_some() {
            "error".into()
        } else {
            snapshot.state
        };
        current.assistant_text = snapshot.assistant_text;
        // Worker 最终文本是持久化权威；播放器不得用旧快照覆盖 summary/report。
        if snapshot.error.is_some() {
            current.error = snapshot.error;
        }
        current.playback = snapshot.playback;
        current.revision += 1;
        (current.clone(), new_error)
    };
    // 播放进度不写数据库；首次播放失败是低频终态，必须随文字一起保存。
    if new_error {
        save_voice_conversation(&state, &value)?;
    }
    app.emit("host://voice-snapshot", value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_voice_conversations(state: State<'_, Arc<DesktopState>>) -> Result<Vec<Value>, String> {
    let current = state
        .conversation
        .lock()
        .map_err(|_| "conversation unavailable")?
        .clone();
    let mut saved = state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_conversations()
        .map_err(|error| error.to_string())?;
    if let Some(current) = current {
        saved.retain(|value| value["requestId"] != current.request_id);
        saved.insert(
            0,
            serde_json::to_value(current).map_err(|error| error.to_string())?,
        );
    }
    Ok(saved)
}

/// 最终文字经 Worker 回传后保存；逐帧播放事件只更新内存并广播。
fn handle_voice_message(app: &tauri::AppHandle, message: &Envelope) -> Result<(), String> {
    let Envelope::Event {
        kind,
        request_id,
        payload,
        ..
    } = message
    else {
        return Ok(());
    };
    let state = app.state::<Arc<DesktopState>>();
    let update = {
        let mut guard = state
            .conversation
            .lock()
            .map_err(|_| "conversation unavailable")?;
        let Some(previous) = guard.as_ref() else {
            return Ok(());
        };
        let Some(mut update) =
            semi_os_host::voice::apply_voice_event(previous, &request_id.0, kind, payload)?
        else {
            return Ok(());
        };
        update.conversation.revision += 1;
        guard.replace(update.conversation.clone());
        update
    };
    if update.persist {
        save_voice_conversation(&state, &update.conversation)?;
    }
    if update.refresh_sessions {
        let sessions = state
            .storage
            .lock()
            .map_err(|_| "storage unavailable")?
            .as_ref()
            .ok_or("storage unavailable")?
            .load_client_sessions()
            .map_err(|error| error.to_string())?;
        let _ = app.emit("host://client-sessions", sessions);
    }
    app.emit("host://voice-snapshot", update.conversation)
        .map_err(|error| error.to_string())
}

fn save_voice_conversation(state: &DesktopState, value: &Conversation) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let saved = value.saved();
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_mut()
        .ok_or("storage unavailable")?
        .save_conversation(
            &value.request_id,
            &serde_json::to_value(saved).map_err(|error| error.to_string())?,
            now,
        )
        .map_err(|error| error.to_string())
}

fn send_evidence_ack(
    state: &DesktopState,
    message: &Envelope,
    result: Result<(), String>,
) -> Result<(), String> {
    let Envelope::Event {
        request_id,
        payload,
        ..
    } = message
    else {
        return Err("invalid policy request".into());
    };
    state.worker.lock().map_err(|_| "worker unavailable")?.as_ref().ok_or("worker unavailable")?.send(Envelope::Request {
        protocol_version: 1, request_id: RequestId(request_id.0.clone()), kind: "research.persisted".into(),
        payload: json!({"operationId":payload["operationId"],"ok":result.is_ok(),"error":result.err()}),
        context: EnvelopeContext { task_id: None, task_run_id: None, trace_id: None },
    })
}

/// 确认只接受 Host 缓存的请求 ID；UI 不能换输入、替换摘要或批量授权。
#[tauri::command]
fn confirm_research_action(
    state: State<'_, Arc<DesktopState>>,
    operation_id: String,
    approved: bool,
) -> Result<(), String> {
    let message = state
        .confirmations
        .lock()
        .map_err(|_| "confirmation unavailable")?
        .remove(&operation_id)
        .ok_or("confirmation expired")?;
    let Envelope::Event { payload, .. } = &message else {
        return Err("invalid confirmation".into());
    };
    let value = &payload["value"];
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let result = (|| {
        let Envelope::Event { payload, .. } = &message else {
            return Err("invalid confirmation".into());
        };
        if now - payload["value"]["requestedAtMs"].as_i64().unwrap_or(0) > 120_000 {
            return Err("confirmation expired".into());
        }
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        storage
            .save_research_approval(
                value["approvalId"].as_str().ok_or("missing approval")?,
                value["taskId"].as_str().ok_or("missing task")?,
                value["toolName"].as_str().ok_or("missing tool")?,
                value["inputDigest"].as_str().ok_or("missing digest")?,
                approved,
                now,
            )
            .map_err(|e| e.to_string())?;
        if approved {
            Ok(())
        } else {
            Err("用户拒绝此操作".into())
        }
    })();
    send_evidence_ack(&state, &message, result)
}

#[tauri::command]
fn get_research_archive(state: State<'_, Arc<DesktopState>>) -> Result<Vec<Value>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_research_archive()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_research_sources(
    state: State<'_, Arc<DesktopState>>,
    task_id: String,
) -> Result<Vec<Value>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_research_sources(&task_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_research_artifact(
    state: State<'_, Arc<DesktopState>>,
    task_id: String,
    artifact_id: String,
) -> Result<Option<String>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_artifact_text(&task_id, &artifact_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_research_report(
    state: State<'_, Arc<DesktopState>>,
    task_id: String,
) -> Result<Option<Value>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_research_report(&task_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn find_workflows(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    name: String,
    repository: String,
    status: String,
) -> Result<Vec<WorkflowSnapshotDto>, String> {
    if window.label() != "client" {
        return Err("only client may query workflows".into());
    }
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .find_workflows_dto(&name, &repository, &status)
        .map_err(|e| e.to_string())
}

/// 通知携带精确身份，不依赖最近列表的分页上限。
#[tauri::command]
fn get_workflow(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    workflow_id: String,
) -> Result<Option<WorkflowSnapshotDto>, String> {
    if window.label() != "client" {
        return Err("only client may query workflows".into());
    }
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_workflow_dto(&workflow_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workflows(
    state: State<'_, Arc<DesktopState>>,
    session_id: String,
) -> Result<Vec<WorkflowSnapshotDto>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_workflows_dto(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decide_workflow(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request: WorkflowUserDecisionRequest,
) -> Result<WorkflowSnapshotDto, String> {
    let WorkflowUserDecisionRequest {
        workflow_id,
        version,
        digest,
        decision,
        reason,
    } = request;
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may decide a workflow".into());
    }
    if matches!(decision, WorkflowUserDecision::NeedsRevision)
        && reason
            .as_deref()
            .is_none_or(|s| s.trim().is_empty() || s.encode_utf16().count() > 8000)
    {
        return Err("请填写计划修改要求".into());
    }
    let snapshot = state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_mut()
        .ok_or("storage unavailable")?
        .decide_workflow_with_reason(
            &workflow_id,
            version,
            &digest,
            decision.as_storage_value(),
            reason.as_deref(),
            unix_time_ms(),
        )
        .map_err(|e| e.to_string())?;
    let snapshot_dto = snapshot;
    publish_workflow(&app, &snapshot_dto)?;
    // 决策已经持久化，Worker 暂时离线不能使 UI 误以为批准失败。
    if notify_workflow_worker(&state, &snapshot_dto, decision.as_storage_value()).is_err() {
        let _ = app.emit(
            "host://workflow-notification-pending",
            &snapshot_dto.plan.workflow_id,
        );
    }
    Ok(snapshot_dto)
}

/// 先撤销数据库授权，再通知进程；Worker 即使迟到也无法开始新的操作。
#[tauri::command]
fn control_workflow(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request: WorkflowControlRequest,
) -> Result<WorkflowSnapshotDto, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only the client may control a workflow".into());
    }
    let WorkflowControlRequest {
        workflow_id,
        version,
        digest,
        action,
    } = request;
    let action_value = action.as_storage_value();
    let snapshot = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let old = storage
            .load_workflow_dto(&workflow_id)
            .map_err(|e| e.to_string())?
            .ok_or("unknown workflow")?;
        if old.plan.version != version || old.digest != digest {
            return Err("计划已经变化，请刷新后操作".into());
        }
        if matches!(action, WorkflowControlAction::ResumeCoordinator) {
            storage.resume_workflow_coordinator(&workflow_id, unix_time_ms())
        } else {
            storage.control_workflow(&workflow_id, action_value, unix_time_ms())
        }
        .map_err(|e| e.to_string())?
    };
    let snapshot_dto = snapshot;
    publish_workflow(&app, &snapshot_dto)?;
    if notify_workflow_worker(&state, &snapshot_dto, action_value).is_err() {
        let _ = app.emit(
            "host://workflow-notification-pending",
            &snapshot_dto.plan.workflow_id,
        );
    }
    Ok(snapshot_dto)
}

/// 真人入口，先落盘撤销旧授权；扩大目标不能通过子 Agent 问答悄悄批准。
#[tauri::command]
fn change_workflow_requirement(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request: WorkflowRequirementChangeRequest,
) -> Result<WorkflowSnapshotDto, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only client users may change requirements".into());
    }
    let WorkflowRequirementChangeRequest {
        workflow_id,
        version,
        digest,
        text,
    } = request;
    let snapshot = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let old = storage
            .load_workflow_dto(&workflow_id)
            .map_err(|e| e.to_string())?
            .ok_or("unknown workflow")?;
        if old.plan.version != version || old.digest != digest {
            return Err("计划已经变化，请刷新".into());
        }
        storage
            .change_workflow_intent(&workflow_id, &text, unix_time_ms())
            .map_err(|e| e.to_string())?
    };
    let snapshot_dto = snapshot;
    publish_workflow(&app, &snapshot_dto)?;
    let _ = notify_workflow_worker(&state, &snapshot_dto, "needs_revision");
    Ok(snapshot_dto)
}

#[tauri::command]
fn answer_workflow_question(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request: WorkflowQuestionAnswerRequest,
) -> Result<WorkflowSnapshotDto, String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only client users may answer delegated questions".into());
    }
    let WorkflowQuestionAnswerRequest {
        workflow_id,
        request_id,
        answer,
    } = request;
    let snapshot = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        guard
            .as_mut()
            .ok_or("storage unavailable")?
            .answer_workflow_decision(&workflow_id, &request_id, &answer, unix_time_ms())
            .map_err(|e| e.to_string())?
    };
    let snapshot_dto = snapshot;
    publish_workflow(&app, &snapshot_dto)?;
    // 决定已保存，通知丢失不回滚；Worker 重启后先核对，不模拟用户输入。
    let notification = Envelope::Request {
        protocol_version: 1,
        request_id: RequestId(format!(
            "req_workflow_answer_{}",
            TEXT_INPUT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )),
        kind: "workflow.control".into(),
        payload: json!({"workflowId":workflow_id,"sessionId":snapshot_dto.plan.session_id,
            "action":"answer_decision","requestId":request_id}),
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    };
    if state
        .worker
        .lock()
        .map_err(|_| "worker unavailable")?
        .as_ref()
        .is_none_or(|worker| worker.send(notification).is_err())
    {
        let _ = app.emit(
            "host://workflow-notification-pending",
            &snapshot_dto.plan.workflow_id,
        );
    }
    Ok(snapshot_dto)
}

fn notify_workflow_worker(
    state: &DesktopState,
    snapshot: &WorkflowSnapshotDto,
    action: &str,
) -> Result<(), String> {
    state.worker.lock().map_err(|_| "worker unavailable")?.as_ref().ok_or("worker unavailable")?
        .send(Envelope::Request {
            protocol_version: 1,
            request_id: RequestId(format!("req_workflow_control_{}", TEXT_INPUT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed))),
            kind: "workflow.control".into(),
            payload: json!({"workflowId":snapshot.plan.workflow_id,"sessionId":snapshot.plan.session_id,"action":action}),
            context: EnvelopeContext { task_id: None, task_run_id: None, trace_id: None },
        })
}

/// 核对、停止及追加指令只来自客户端用户；追加信息不能直接改变批准边界。
#[tauri::command]
fn inspect_workflow_run(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    workflow_id: String,
    run_id: String,
    request_id: String,
    action: String,
    text: Option<String>,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW
        || !["inspect", "reconcile", "steer", "answer"].contains(&action.as_str())
    {
        return Err("only client users can reconcile a run".into());
    }
    let snapshot = state
        .storage
        .lock()
        .map_err(|_| "storage unavailable")?
        .as_ref()
        .ok_or("storage unavailable")?
        .load_workflow_dto(&workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or("unknown workflow")?;
    let run = snapshot
        .runs
        .iter()
        .find(|run| run.run_id == run_id)
        .ok_or("unknown run")?;
    if action == "reconcile" && !["unknown", "blocked"].contains(&run.status.as_str()) {
        return Err("only uncertain or blocked attempts can be reconciled".into());
    }
    if ["steer", "answer"].contains(&action.as_str()) {
        if text
            .as_deref()
            .is_none_or(|value| value.trim().is_empty() || value.encode_utf16().count() > 8000)
        {
            return Err("请输入追加指令".into());
        }
        let required = if action == "steer" {
            &["running"][..]
        } else {
            &["blocked", "unknown"][..]
        };
        if !required.contains(&run.status.as_str()) {
            return Err("执行状态已变化，请重新查看".into());
        }
    }
    let envelope = Envelope::Request {
        protocol_version: 1,
        request_id: RequestId(request_id),
        kind: format!("workflow.run.{action}"),
        payload: json!({"workflowId":workflow_id,"runId":run_id,"sessionId":snapshot.plan.session_id,"text":text}),
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    };
    validate_envelope(&envelope).map_err(|e| e.message)?;
    state
        .worker
        .lock()
        .map_err(|_| "worker unavailable")?
        .as_ref()
        .ok_or("worker unavailable")?
        .send(envelope)
}

fn unix_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 应用源分支仅由客户端独立确认；Worker 只能消费此处已经落盘的精确批准。
#[tauri::command]
fn apply_workflow_result(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<DesktopState>>,
    request_id: String,
    workflow_id: String,
    application: Option<semi_os_protocol::WorkflowApplication>,
) -> Result<(), String> {
    if window.label() != CLIENT_WINDOW {
        return Err("only client users can apply results".into());
    }
    let session_id = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let snapshot = storage
            .load_workflow_dto(&workflow_id)
            .map_err(|e| e.to_string())?
            .ok_or("unknown workflow")?;
        if let Some(request) = &application {
            if request.workflow_id != workflow_id {
                return Err("application workflow mismatch".into());
            }
            storage
                .approve_workflow_application(request, unix_time_ms())
                .map_err(|e| e.to_string())?;
            if let Some(updated) = storage
                .load_workflow_dto(&workflow_id)
                .map_err(|e| e.to_string())?
            {
                publish_workflow(&app, &updated)?;
            }
        }
        snapshot.plan.session_id.clone()
    };
    let envelope = Envelope::Request {
        protocol_version: 1,
        request_id: RequestId(request_id),
        kind: if application.is_some() {
            "workflow.application.apply"
        } else {
            "workflow.application.prepare"
        }
        .into(),
        payload: json!({"workflowId":workflow_id,"sessionId":session_id,"applicationId":application.map(|a|a.application_id)}),
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    };
    validate_envelope(&envelope).map_err(|e| e.message)?;
    state
        .worker
        .lock()
        .map_err(|_| "worker unavailable")?
        .as_ref()
        .ok_or("Worker 离线，批准已保留，请核对后继续")?
        .send(envelope)
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
        .map_err(|_| "host lifecycle lock is unavailable".to_owned())
        .and_then(|mut lifecycle| {
            route_lifecycle(&mut lifecycle, LifecycleCommand::Read)
                .map_err(|error| error.ui_message().to_owned())
        })
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
    if let Envelope::Request { kind, .. } = &envelope {
        if !kind.starts_with("voice.") && kind != "health.check" && kind != "browser.login.open" {
            return Err("internal Host messages cannot be sent by a WebView".into());
        }
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
            environment: vec![
                (
                    "SEMI_OS_WORKTREE_DIR".into(),
                    data_dir.join("worktrees").to_string_lossy().into_owned(),
                ),
                (
                    "SEMI_OS_COORDINATOR_DIR".into(),
                    data_dir.join("coordinators").to_string_lossy().into_owned(),
                ),
                (
                    "SEMI_OS_AGENT_WORKSPACE".into(),
                    data_dir
                        .join("agent-workspace")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ],
        },
        RestartPolicy::default(),
        Arc::new(DiagnosticStore::new(diagnostics_path)),
        Arc::new(move |event: WorkerEvent| {
            if matches!(event, WorkerEvent::Starting { .. }) {
                let state = app_handle.state::<Arc<DesktopState>>();
                if let Ok(mut guard) = state.storage.lock() {
                    if let Some(storage) = guard.as_mut() {
                        if storage.recover_workflow_runs(unix_time_ms()).is_err() {
                            let _ = app_handle.emit(
                                "host://workflow-recovery-error",
                                "协作恢复失败，请先核对工作区",
                            );
                        }
                    }
                };
            }
            if matches!(event, WorkerEvent::Ready { .. }) {
                // Ready 时 stdin 已建立；先释放数据库锁，再通知 Worker 消费持久事件。
                let state = app_handle.state::<Arc<DesktopState>>();
                let snapshots = state
                    .storage
                    .lock()
                    .map_err(|_| "storage unavailable".to_string())
                    .and_then(|guard| {
                        guard
                            .as_ref()
                            .ok_or_else(|| "storage unavailable".to_string())?
                            .workflow_recovery_snapshots_dto()
                            .map_err(|error| error.to_string())
                    })
                    .unwrap_or_else(|_| {
                        let _ = app_handle.emit(
                            "host://workflow-recovery-error",
                            "协作记录读取失败，请先核对记录与工作区",
                        );
                        Vec::new()
                    });
                for snapshot in snapshots {
                    let _ = publish_workflow(&app_handle, &snapshot);
                    if notify_workflow_worker(&state, &snapshot, "observe").is_err() {
                        let _ = app_handle.emit(
                            "host://workflow-notification-pending",
                            &snapshot.plan.workflow_id,
                        );
                    }
                }
            }
            // UI 只接收 WorkerEvent 中经过约束的字段，不转发 stderr 或环境变量。
            let _ = app_handle.emit("host://worker-event", event);
        }),
        Arc::new(move |message| {
            match handle_workflow_message(&message_app_handle, &message) {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => {
                    let _ = message_app_handle.emit("host://research-error", error);
                    return;
                }
            }
            if let Err(error) = handle_voice_message(&message_app_handle, &message) {
                let _ = message_app_handle.emit("host://research-error", error);
            }
            match handle_research_message(&message_app_handle, &message) {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => {
                    let _ = message_app_handle.emit("host://research-error", error);
                    return;
                }
            }
            // 所有消息已经在 Supervisor 中完成版本和 Envelope 校验；UI 仍需按
            // kind 解析领域载荷，不能把任意 Worker JSON 当作可信 DOM 内容。
            let _ = message_app_handle.emit("host://worker-message", message);
        }),
    );
    Ok(supervisor
        .with_receipts(&data_dir.join("semi-os.sqlite"))
        .map_err(|error| error.to_string())?
        .start())
}

fn shutdown(state: &Arc<DesktopState>) {
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        let _ = route_lifecycle(&mut lifecycle, LifecycleCommand::BeginShutdown);
    }
    if let Ok(mut worker) = state.worker.lock() {
        if let Some(mut handle) = worker.take() {
            handle.stop();
        }
    }
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        let _ = route_lifecycle(&mut lifecycle, LifecycleCommand::MarkStopped);
    }
}

fn main() {
    let state = Arc::new(DesktopState {
        lifecycle: Mutex::new(HostLifecycle::default()),
        worker: Mutex::new(None),
        storage: Mutex::new(None),
        confirmations: Mutex::new(std::collections::HashMap::new()),
        conversation: Mutex::new(None),
        voice_settings: Mutex::new(VoiceSettings::default()),
        text_input: Mutex::new(text_input::TextInputRelay::default()),
        workflow_notices: Mutex::new(std::collections::HashMap::new()),
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
            send_worker_request,
            get_research_sources,
            get_research_archive,
            get_research_artifact,
            get_research_report,
            get_workflows,
            find_workflows,
            get_workflow,
            decide_workflow,
            control_workflow,
            change_workflow_requirement,
            answer_workflow_question,
            inspect_workflow_run,
            apply_workflow_result,
            confirm_research_action,
            start_voice_conversation,
            publish_voice_snapshot,
            get_voice_conversations,
            get_client_sessions,
            change_client_session,
            rename_client_session,
            activate_client_session,
            record_voice_playback,
            record_voice_timing,
            get_voice_settings,
            set_voice_settings,
            get_agent_workspace,
            register_text_input_controller,
            submit_text_message,
            acknowledge_text_message
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
            // CSS 透明不足以实现桌面悬浮；原生鼠标穿透确保不拦截其他应用。
            if let Some(assistant) = app.get_webview_window(ASSISTANT_WINDOW) {
                assistant.set_shadow(false)?;
                assistant.set_ignore_cursor_events(true)?;
            }
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
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            *desktop_state
                .voice_settings
                .lock()
                .map_err(|_| "settings unavailable")? =
                voice_settings::load(&data_dir.join("voice-settings.json"))?;
            desktop_state
                .storage
                .lock()
                .map_err(|_| "storage unavailable")?
                .replace(Storage::open(data_dir.join("semi-os.sqlite"))?);
            let worker = start_worker(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
            desktop_state
                .worker
                .lock()
                .map_err(|_| "worker supervisor lock is unavailable")?
                .replace(worker);
            let mut lifecycle = desktop_state
                .lifecycle
                .lock()
                .map_err(|_| "host lifecycle lock is unavailable")?;
            route_lifecycle(
                &mut lifecycle,
                LifecycleCommand::MarkReady {
                    shortcut_registered: true,
                },
            )
            .map(|_| ())
            .map_err(|error| error.ui_message())?;

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
