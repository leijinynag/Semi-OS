use semi_os_host::conversation::Conversation;
use semi_os_host::{
    DiagnosticRecord, DiagnosticStore, HostLifecycle, HostLifecycleSnapshot, RestartPolicy,
    WorkerCommand, WorkerEvent, WorkerSupervisor, WorkerSupervisorHandle,
};
use semi_os_protocol::{
    validate_envelope, Envelope, EnvelopeContext, RequestId, ToolExecutionReceipt,
};
use semi_os_storage::{ClientSession, Storage};
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
    if ![
        "voice.transcript.partial",
        "voice.transcript.final",
        "voice.answer",
        "voice.error",
        "voice.turn.completed",
        "voice.state",
    ]
    .contains(&kind.as_str())
    {
        return Ok(());
    }
    let state = app.state::<Arc<DesktopState>>();
    let value = {
        let mut guard = state
            .conversation
            .lock()
            .map_err(|_| "conversation unavailable")?;
        let Some(previous) = guard.as_ref() else {
            return Ok(());
        };
        if previous.request_id != request_id.0 {
            return Ok(());
        }
        if payload
            .get("sessionId")
            .is_some_and(|id| id != &previous.session_id)
            || payload
                .get("taskId")
                .is_some_and(|id| id != &previous.task_id)
        {
            return Err("voice identity mismatch".into());
        }
        // 先验证副本再替换，畸形 Worker 事件不能破坏当前可恢复快照。
        let mut current = previous.clone();
        match kind.as_str() {
            "voice.transcript.partial" | "voice.transcript.final" => {
                current.transcript = payload["text"].as_str().ok_or("invalid transcript")?.into();
            }
            "voice.answer" => {
                current.summary = payload["summary"].as_str().ok_or("invalid summary")?.into();
                current.report = payload["report"].as_str().ok_or("invalid report")?.into();
            }
            "voice.error" => {
                current.state = "error".into();
                current.error = Some(
                    payload["message"]
                        .as_str()
                        .ok_or("invalid voice error")?
                        .into(),
                );
            }
            "voice.state" if payload["state"] != "idle" && current.error.is_none() => {
                // 合成结束不能把仍在播放的快照置为 idle。
                current.state = payload["state"].as_str().ok_or("invalid state")?.into();
            }
            _ => {}
        }
        current.validate()?;
        current.revision += 1;
        guard.replace(current.clone());
        current
    };
    if [
        "voice.transcript.final",
        "voice.answer",
        "voice.error",
        "voice.turn.completed",
    ]
    .contains(&kind.as_str())
    {
        save_voice_conversation(&state, &value)?;
        if kind == "voice.transcript.final" {
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
    }
    app.emit("host://voice-snapshot", value)
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

/// 持久化先于 UI 发布。回执经 Host 策略校验，来源经正文引用校验。
fn handle_research_message(app: &tauri::AppHandle, message: &Envelope) -> Result<bool, String> {
    let Envelope::Event {
        kind,
        payload,
        request_id,
        ..
    } = message
    else {
        return Ok(false);
    };
    if ![
        "research.persist",
        "research.receipt",
        "research.progress",
        "research.policy.cancelled",
        "voice.turn.completed",
        "research.interrupted",
    ]
    .contains(&kind.as_str())
    {
        return Ok(false);
    }
    let state = app.state::<Arc<DesktopState>>();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    if kind == "research.policy.cancelled" {
        if let Some(id) = payload["operationId"].as_str() {
            state
                .confirmations
                .lock()
                .map_err(|_| "confirmation unavailable")?
                .remove(id);
            app.emit("host://research-confirmation-expired", id)
                .map_err(|e| e.to_string())?;
        }
        return Ok(true);
    }
    if kind == "voice.turn.completed" || kind == "research.interrupted" {
        let task = payload["taskId"].as_str().ok_or("missing task")?;
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        if kind == "voice.turn.completed" {
            semi_os_host::research::finish_turn(storage, task, now)?;
        } else if let Some(snapshot) = storage.load_task(task).map_err(|e| e.to_string())? {
            let to = if payload["mode"] == "cancel" {
                semi_os_protocol::TaskLifecycle::Cancelled
            } else {
                semi_os_protocol::TaskLifecycle::Paused
            };
            // Unknown 必须保留待对账状态；已结束或尚未执行的任务不强制变成 Paused。
            if semi_os_host::TaskStateMachine::can_transition(snapshot.lifecycle, to) {
                semi_os_host::research::transition(storage, task, to, now)?;
            }
        }
        return Ok(false);
    }
    if kind == "research.persist" && payload["operation"] == "policy" {
        let value = &payload["value"];
        if let Err(error) = semi_os_host::research::validate_policy(value) {
            send_evidence_ack(&state, message, Err(error))?;
            return Ok(true);
        }
        let task = value["taskId"].as_str().ok_or("missing policy task")?;
        let risk = value["riskLevel"].as_str().ok_or("missing policy risk")?;
        if !["read", "local_write", "external_side_effect", "privileged"].contains(&risk) {
            return Err("invalid risk".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        {
            let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
            semi_os_host::research::ensure_task(
                guard.as_mut().ok_or("storage unavailable")?,
                task,
                now,
            )?;
        }
        if risk == "read" || risk == "local_write" {
            send_evidence_ack(&state, message, Ok(()))?;
        } else {
            let id = payload["operationId"].as_str().ok_or("missing operation")?;
            state
                .confirmations
                .lock()
                .map_err(|_| "confirmation unavailable")?
                .insert(id.into(), {
                    let mut pending = message.clone();
                    if let Envelope::Event { payload, .. } = &mut pending {
                        payload["value"]["requestedAtMs"] = json!(now);
                    }
                    pending
                });
            app.emit("host://research-confirmation", payload.clone())
                .map_err(|e| e.to_string())?;
            state
                .worker
                .lock()
                .map_err(|_| "worker unavailable")?
                .as_ref()
                .ok_or("worker unavailable")?
                .send(Envelope::Request {
                    protocol_version: 1,
                    request_id: RequestId(id.into()),
                    kind: "research.confirmation.required".into(),
                    payload: json!({"taskId": task}),
                    context: EnvelopeContext {
                        task_id: None,
                        task_run_id: None,
                        trace_id: None,
                    },
                })?;
        }
        return Ok(true);
    }
    let result = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        match kind.as_str() {
            "research.persist" => match payload["operation"].as_str() {
                Some("source") => semi_os_host::research::save_source(storage, &payload["value"]),
                Some("report") => semi_os_host::research::save_report(storage, &payload["value"]),
                _ => Err("invalid persistence operation".into()),
            },
            "research.receipt" => serde_json::from_value::<ToolExecutionReceipt>(payload.clone())
                .map_err(|e| e.to_string())
                .and_then(|r| semi_os_host::research::save_receipt(storage, &r)),
            _ => {
                let task = payload["taskId"].as_str().ok_or("missing task")?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                semi_os_host::research::record_progress(storage, task, payload.clone(), now)
            }
        }
    };
    if kind == "research.persist" {
        let reply = Envelope::Request {
            protocol_version: 1,
            request_id: RequestId(request_id.0.clone()),
            kind: "research.persisted".into(),
            payload: json!({"operationId":payload["operationId"],"ok":result.is_ok(),"error":result.as_ref().err()}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        state
            .worker
            .lock()
            .map_err(|_| "worker unavailable")?
            .as_ref()
            .ok_or("worker unavailable")?
            .send(reply)?;
        if result.is_ok() && payload["operation"] == "source" {
            let mut source = payload["value"].clone();
            if let Some(object) = source.as_object_mut() {
                object.remove("text");
            }
            let _ = app.emit("host://research-source", source);
        }
        return Ok(true);
    }
    result?;
    Ok(false)
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
        storage: Mutex::new(None),
        confirmations: Mutex::new(std::collections::HashMap::new()),
        conversation: Mutex::new(None),
        voice_settings: Mutex::new(VoiceSettings::default()),
        text_input: Mutex::new(text_input::TextInputRelay::default()),
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
