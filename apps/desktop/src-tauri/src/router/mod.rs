//! Tauri 路由适配层：窗口/回执组装留在此处，业务与持久化交给 Host。
use super::*;

/// 与研究证据共用 Host 存储，但协作协议独立，避免编码任务变成“研究报告”。
pub(super) fn handle_workflow_message(
    app: &tauri::AppHandle,
    message: &Envelope,
) -> Result<bool, String> {
    let Envelope::Event {
        kind,
        payload,
        request_id,
        ..
    } = message
    else {
        return Ok(false);
    };
    if kind != "workflow.request" {
        return Ok(false);
    }
    let state = app.state::<Arc<DesktopState>>();
    let mut effects = None;
    let result = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        let now = unix_time_ms();
        semi_os_host::workflow::dispatch_request(storage, message, now)
            .and_then(|outcome| {
                effects = Some(semi_os_host::workflow::operation_effects(
                    payload, &outcome,
                )?);
                let reply = outcome.result;
                if reply.ok {
                    Ok(reply.value.unwrap_or(Value::Null))
                } else {
                    Err(semi_os_host::HostError::InvalidRequest(
                        reply.error.unwrap_or_else(|| "RPC failed".into()),
                    ))
                }
            })
            .map_err(|error| error.ui_message().to_string())
    };
    state.worker.lock().map_err(|_| "worker unavailable")?.as_ref().ok_or("worker unavailable")?
        .send(Envelope::Request {
            protocol_version: 1, request_id: request_id.clone(), kind: "workflow.acknowledged".into(),
            payload: json!({"operationId":payload["operationId"],"ok":result.is_ok(),"value":result.as_ref().ok(),"error":result.as_ref().err()}),
            context: EnvelopeContext { task_id: None, task_run_id: None, trace_id: None },
        })?;
    if let Some(effects) = effects {
        if let Some(snapshot) = effects.snapshot {
            publish_workflow(app, &snapshot)?;
            if let Some(notification) = effects.notification {
                notify_workflow_worker(&state, &snapshot, notification)?;
            }
        }
    }
    Ok(true)
}

/// 持久化先于 UI 发布。回执经 Host 策略校验，来源经正文引用校验。
pub(super) fn handle_research_message(
    app: &tauri::AppHandle,
    message: &Envelope,
) -> Result<bool, String> {
    let Some(route) = semi_os_host::research_router::route_research(message)? else {
        return Ok(false);
    };
    let Envelope::Event { request_id, .. } = message else {
        return Ok(false);
    };
    let state = app.state::<Arc<DesktopState>>();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    if let semi_os_host::research_router::ResearchRoute::PolicyCancelled { operation_id } = &route {
        if let Some(id) = operation_id {
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
    if matches!(
        &route,
        semi_os_host::research_router::ResearchRoute::TurnCompleted { .. }
            | semi_os_host::research_router::ResearchRoute::Interrupted { .. }
    ) {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        semi_os_host::research_router::persist_route(
            guard.as_mut().ok_or("storage unavailable")?,
            &route,
            now,
        )
        .map_err(|error| error.ui_message().to_string())?;
        drop(guard);
        if let Envelope::Event { payload, .. } = message {
            app.emit("host://task-execution", &payload["taskId"])
                .map_err(|error| error.to_string())?;
        }
        return Ok(false);
    }
    if let semi_os_host::research_router::ResearchRoute::Policy { payload } = &route {
        let value = &payload["value"];
        let decision = {
            let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
            semi_os_host::research_router::prepare_policy(
                guard.as_mut().ok_or("storage unavailable")?,
                payload,
                now,
            )
        };
        let automatic = match decision {
            Ok(automatic) => automatic,
            Err(error) => {
                send_evidence_ack(&state, message, Err(error.ui_message().into()))?;
                return Ok(true);
            }
        };
        let task = value["taskId"].as_str().ok_or("missing policy task")?;
        if automatic {
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
                .send(semi_os_host::research_router::confirmation_request(
                    id, task,
                ))?;
        }
        return Ok(true);
    }
    let is_persist_event = matches!(
        &route,
        semi_os_host::research_router::ResearchRoute::Persist { .. }
    );
    let mut replayed = false;
    let result = {
        let mut guard = state.storage.lock().map_err(|_| "storage unavailable")?;
        let storage = guard.as_mut().ok_or("storage unavailable")?;
        if is_persist_event {
            // 只缓存证据落盘回执；权限批准有时效性，不能从历史 RPC 中重放授权。
            semi_os_host::rpc::dispatch(storage, message, now, |storage| {
                semi_os_host::research_router::persist_route(storage, &route, now)?;
                Ok(Value::Null)
            })
            .and_then(|outcome| {
                replayed = outcome.replayed;
                let reply = outcome.result;
                if reply.ok {
                    Ok(())
                } else {
                    Err(semi_os_host::HostError::InvalidRequest(
                        reply.error.unwrap_or_else(|| "RPC failed".into()),
                    ))
                }
            })
            .map_err(|error| error.ui_message().to_string())
        } else {
            semi_os_host::research_router::persist_route(storage, &route, now)
                .map_err(|error| error.ui_message().to_string())
        }
    };
    let execution_task = match &route {
        semi_os_host::research_router::ResearchRoute::Persist { payload, .. } => {
            payload["value"]["taskId"].as_str()
        }
        semi_os_host::research_router::ResearchRoute::Receipt { payload }
        | semi_os_host::research_router::ResearchRoute::Progress { payload } => {
            payload["taskId"].as_str()
        }
        _ => None,
    };
    // 只通知 Host 已接受的事实；WebView 随后读取持久投影，不消费未落盘的 Worker 结果。
    if result.is_ok() {
        if let Some(task) = execution_task {
            app.emit("host://task-execution", task)
                .map_err(|error| error.to_string())?;
        }
    }
    let payload = match route {
        semi_os_host::research_router::ResearchRoute::Persist { payload, .. } => payload,
        semi_os_host::research_router::ResearchRoute::Receipt { payload } => payload,
        semi_os_host::research_router::ResearchRoute::Progress { payload } => payload,
        _ => return Ok(false),
    };
    if is_persist_event {
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
        if !replayed && result.is_ok() && payload["operation"] == "source" {
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
