use semi_os_protocol::Envelope;
use serde_json::Value;

/// Research/voice 事件的稳定分类。
///
/// 分类函数只做领域映射，持久化和策略由本模块的独立 handler 处理；
/// 所有分支都不依赖 Worker 或 WebView，允许直接使用 SQLite Fixture 测试。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResearchRoute {
    PolicyCancelled {
        operation_id: Option<String>,
    },
    TurnCompleted {
        task_id: String,
    },
    Interrupted {
        task_id: String,
        mode: Option<String>,
    },
    Policy {
        payload: Value,
    },
    Persist {
        operation: Option<String>,
        payload: Value,
    },
    Receipt {
        payload: Value,
    },
    Progress {
        payload: Value,
    },
}

/// 将 Worker 事件分类为 research Host 路由。
///
/// `None` 表示该消息属于其他领域；这不是错误，调用方应继续交给后续
/// router。这里仅校验当前分支必需的身份字段，避免缺少 taskId 的终态
/// 事件在 Storage 层才失败。
pub fn route_research(message: &Envelope) -> Result<Option<ResearchRoute>, String> {
    let Envelope::Event { kind, payload, .. } = message else {
        return Ok(None);
    };

    match kind.as_str() {
        "research.policy.cancelled" => Ok(Some(ResearchRoute::PolicyCancelled {
            operation_id: payload["operationId"].as_str().map(str::to_owned),
        })),
        "voice.turn.completed" => Ok(Some(ResearchRoute::TurnCompleted {
            task_id: required_task_id(payload)?,
        })),
        "research.interrupted" => Ok(Some(ResearchRoute::Interrupted {
            task_id: required_task_id(payload)?,
            mode: payload["mode"].as_str().map(str::to_owned),
        })),
        "research.persist" if payload["operation"] == "policy" => Ok(Some(ResearchRoute::Policy {
            payload: payload.clone(),
        })),
        "research.persist" => Ok(Some(ResearchRoute::Persist {
            operation: payload["operation"].as_str().map(str::to_owned),
            payload: payload.clone(),
        })),
        "research.receipt" => Ok(Some(ResearchRoute::Receipt {
            payload: payload.clone(),
        })),
        "research.progress" => Ok(Some(ResearchRoute::Progress {
            payload: payload.clone(),
        })),
        _ => Ok(None),
    }
}

fn required_task_id(payload: &Value) -> Result<String, String> {
    payload["taskId"]
        .as_str()
        .filter(|task| !task.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "missing task".into())
}

/// 持久化与状态转换不依赖窗口；适配层只发送回执和已验证的 UI 事件。
pub fn persist_route(
    storage: &mut semi_os_storage::Storage,
    route: &ResearchRoute,
    now: i64,
) -> crate::HostResult<()> {
    let result = match route {
        ResearchRoute::TurnCompleted { task_id } => {
            crate::research::finish_turn(storage, task_id, now)
        }
        ResearchRoute::Interrupted { task_id, mode } => {
            if let Some(snapshot) = storage.load_task(task_id)? {
                let to = if mode.as_deref() == Some("cancel") {
                    semi_os_protocol::TaskLifecycle::Cancelled
                } else {
                    semi_os_protocol::TaskLifecycle::Paused
                };
                if crate::TaskStateMachine::can_transition(snapshot.lifecycle, to) {
                    crate::research::transition(storage, task_id, to, now)
                        .map_err(crate::HostError::InvalidRequest)?;
                }
            }
            Ok(())
        }
        ResearchRoute::Persist { operation, payload } => match operation.as_deref() {
            Some("source") => crate::research::save_source(storage, &payload["value"]),
            Some("report") => crate::research::save_report(storage, &payload["value"]),
            _ => Err("invalid persistence operation".into()),
        },
        ResearchRoute::Receipt { payload } => {
            let receipt =
                serde_json::from_value::<semi_os_protocol::ToolExecutionReceipt>(payload.clone())?;
            crate::research::save_receipt(storage, &receipt)
        }
        ResearchRoute::Progress { payload } => {
            let task = required_task_id(payload).map_err(crate::HostError::InvalidRequest)?;
            crate::research::record_progress(storage, &task, payload.clone(), now)
        }
        _ => Err("route does not persist evidence".into()),
    };
    result.map_err(crate::HostError::InvalidRequest)
}

/// 风险判定与任务建立先于确认 UI；模型无权自行跳过协作授权。
pub fn prepare_policy(
    storage: &mut semi_os_storage::Storage,
    payload: &Value,
    now: i64,
) -> crate::HostResult<bool> {
    let value = &payload["value"];
    crate::research::validate_policy(value).map_err(crate::HostError::InvalidRequest)?;
    crate::workflow::guard_native_operation(storage, value)
        .map_err(crate::HostError::InvalidRequest)?;
    let task = required_task_id(value).map_err(crate::HostError::InvalidRequest)?;
    crate::research::ensure_task(storage, &task, now).map_err(crate::HostError::InvalidRequest)?;
    Ok(matches!(
        value["riskLevel"].as_str(),
        Some("read" | "local_write")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_protocol::{EnvelopeContext, RequestId};

    fn event(kind: &str, payload: Value) -> Envelope {
        Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_research".into()),
            kind: kind.into(),
            payload,
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        }
    }

    #[test]
    fn classifies_policy_and_preserves_payload_for_boundary_validation() {
        let route = route_research(&event(
            "research.persist",
            serde_json::json!({
                "operation": "policy",
                "value": {"taskId": "task_1", "riskLevel": "read"}
            }),
        ))
        .expect("policy route")
        .expect("research event");
        assert!(matches!(route, ResearchRoute::Policy { .. }));
    }

    #[test]
    fn rejects_terminal_events_without_task_identity() {
        let error = route_research(&event("voice.turn.completed", serde_json::json!({})))
            .expect_err("terminal events need task identity");
        assert_eq!(error, "missing task");
    }

    #[test]
    fn keeps_unrelated_events_available_to_other_routers() {
        assert_eq!(
            route_research(&event(
                "workflow.request",
                serde_json::json!({"operation": "list"})
            ))
            .expect("unrelated event"),
            None
        );
    }

    #[test]
    fn preserves_unknown_persist_operations_for_a_failure_ack() {
        let route = route_research(&event(
            "research.persist",
            serde_json::json!({"operation": "future_operation", "value": {}}),
        ))
        .expect("persist event")
        .expect("research event");
        assert!(matches!(
            route,
            ResearchRoute::Persist {
                operation: Some(operation),
                ..
            } if operation == "future_operation"
        ));
    }

    #[test]
    fn policy_and_terminal_persistence_work_without_a_webview() {
        use sha2::{Digest, Sha256};

        let mut storage = semi_os_storage::Storage::open_in_memory().unwrap();
        let input = r#"{"url":"https://example.com/"}"#;
        let digest = format!("sha256:{:x}", Sha256::digest(input.as_bytes()));
        let policy = serde_json::json!({"value":{
            "taskId":"task_fixture","toolName":"browser_open","riskLevel":"read",
            "inputDigest":digest,"approvalId":"approval","inputJson":input
        }});
        // read 仍必须通过现有工具策略校验，不能仅凭模型提交的 riskLevel 放行。
        let result = prepare_policy(&mut storage, &policy, 1);
        assert!(result.is_ok(), "{result:?}");
        assert!(storage.load_task("task_fixture").unwrap().is_some());
        let mut invalid = policy;
        invalid["value"]["riskLevel"] = serde_json::json!("arbitrary");
        assert!(prepare_policy(&mut storage, &invalid, 2).is_err());
        persist_route(
            &mut storage,
            &ResearchRoute::Interrupted {
                task_id: "task_fixture".into(),
                mode: Some("cancel".into()),
            },
            3,
        )
        .unwrap();
        assert_eq!(
            storage
                .load_task("task_fixture")
                .unwrap()
                .unwrap()
                .lifecycle,
            semi_os_protocol::TaskLifecycle::Cancelled
        );
    }
}
