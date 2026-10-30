use semi_os_protocol::{PolicyDecision, TaskLifecycle, ToolExecutionReceipt, ToolRiskLevel};
use semi_os_storage::{NewTaskEvent, Storage, TaskSnapshot};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Host 依据工具输入及浏览器观察校验降级，不接受模型填写的 purpose/risk。
pub fn validate_policy(value: &Value) -> Result<(), String> {
    let raw = value["inputJson"].as_str().ok_or("missing input")?;
    let input: Value = serde_json::from_str(raw).map_err(|_| "invalid input")?;
    let digest = format!("sha256:{:x}", Sha256::digest(raw.as_bytes()));
    if value["inputDigest"].as_str() != Some(&digest) {
        return Err("input digest mismatch".into());
    }
    let tool = value["toolName"].as_str().ok_or("missing tool")?;
    let risk = value["riskLevel"].as_str().ok_or("missing risk")?;
    let evidence = &value["evidence"];
    let expected = match tool {
        "read" | "browser_extract" | "workflow_observe" | "coding_read" | "desktop_observe" => {
            "read"
        }
        "write"
        | "edit"
        | "workflow_submit_plan"
        | "workflow_refine_plan"
        | "workflow_dispatch"
        | "workflow_stop"
        | "workflow_resume_run"
        | "workflow_steer"
        | "workflow_test"
        | "workflow_record_finding"
        | "workflow_record_integration" => "local_write",
        "bash" => "privileged",
        "browser_open" => url_risk(input["url"].as_str().ok_or("missing URL")?)?,
        "browser_click" | "browser_type" => {
            if evidence["pageId"] != input["pageId"]
                || evidence["version"] != input["version"]
                || evidence["ref"] != input["ref"]
                || evidence["pageId"].as_str().is_none()
            {
                return Err("missing bound browser observation".into());
            }
            if evidence["search"] == true {
                url_risk(
                    evidence["searchAction"]
                        .as_str()
                        .ok_or("missing search action")?,
                )?
            } else if tool == "browser_click" && evidence["role"] == "link" {
                url_risk(evidence["href"].as_str().ok_or("missing link")?)?
            } else {
                "external_side_effect"
            }
        }
        _ => "external_side_effect",
    };
    if risk != expected {
        return Err("risk does not match bounded tool input".into());
    }
    Ok(())
}

fn url_risk(url: &str) -> Result<&'static str, String> {
    let url = url::Url::parse(url).map_err(|_| "invalid URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("invalid URL protocol".into());
    }
    let target = format!("{}?{}", url.path(), url.query().unwrap_or(""));
    let target = percent_encoding::percent_decode_str(&target)
        .decode_utf8()
        .map_err(|_| "invalid URL encoding")?
        .to_lowercase();
    if [
        "logout",
        "delete",
        "remove",
        "purchase",
        "checkout",
        "subscribe",
        "send",
        "publish",
        "confirm",
        "action=",
        "token=",
        "unsubscribe",
    ]
    .iter()
    .any(|word| target.contains(word))
    {
        Ok("external_side_effect")
    } else {
        Ok("read")
    }
}

/// Host 对跨进程来源做二次校验，引用必须精确对应本任务正文，不相信模型标识。
pub fn save_source(storage: &mut Storage, source: &Value) -> Result<(), String> {
    let field = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    for key in ["sourceId", "taskId", "originalUrl", "finalUrl", "title"] {
        field(key).ok_or_else(|| format!("missing {key}"))?;
    }
    let status = field("status").ok_or("missing status")?;
    if !["collected", "failed", "needs_user"].contains(&status) {
        return Err("invalid status".into());
    }
    let time = source["collectedAtMs"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or("invalid time")?;
    let quotes = source["quotes"].as_array().ok_or("invalid quotes")?;
    if status == "collected" {
        let text = field("text").ok_or("missing body")?;
        if text.len() > 4_000_000 || field("artifactId").is_none() || field("digest").is_none() {
            return Err("invalid artifact".into());
        }
        if field("digest") != Some(format!("sha256:{:x}", Sha256::digest(text.as_bytes())).as_str())
        {
            return Err("body digest mismatch".into());
        }
        // JS offsets 为 UTF-16，不是 Rust UTF-8 字节；跨语言索引必须统一。
        let body: Vec<u16> = text.encode_utf16().collect();
        let mut ids = std::collections::HashSet::new();
        for quote in quotes {
            let id = quote["quoteId"].as_str().ok_or("invalid quote id")?;
            if !ids.insert(id) {
                return Err("duplicate quote".into());
            }
            let start = quote["start"].as_u64().ok_or("invalid quote start")? as usize;
            let end = quote["end"].as_u64().ok_or("invalid quote end")? as usize;
            let slice = body
                .get(start..end)
                .filter(|s| !s.is_empty())
                .ok_or("quote out of bounds")?;
            if String::from_utf16(slice).map_err(|_| "invalid quote encoding")?
                != quote["text"].as_str().ok_or("invalid quote text")?
            {
                return Err("quote does not match body".into());
            }
        }
    } else if !quotes.is_empty()
        || source.get("text").is_some()
        || source.get("artifactId").is_some()
    {
        return Err("failed source cannot carry collected evidence".into());
    }
    ensure_task(storage, field("taskId").unwrap(), time)?;
    storage
        .save_research_source(source)
        .map_err(|e| e.to_string())
}

pub fn save_report(storage: &mut Storage, report: &Value) -> Result<(), String> {
    let task = report["taskId"].as_str().ok_or("missing report task")?;
    let sources = storage
        .load_research_report_sources(task)
        .map_err(|e| e.to_string())?;
    if report["summary"].as_str().is_none() || report["limitations"].as_array().is_none() {
        return Err("invalid report".into());
    }
    if !report["limitations"]
        .as_array()
        .unwrap()
        .iter()
        .all(Value::is_string)
    {
        return Err("invalid limitations".into());
    }
    for claim in report["claims"].as_array().ok_or("missing claims")? {
        if claim["text"].as_str().is_none() {
            return Err("invalid claim".into());
        }
        let citations = claim["citations"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or("claim requires evidence")?;
        for citation in citations {
            let found = sources.iter().any(|s| {
                s["status"] == "collected"
                    && s["sourceId"] == citation["sourceId"]
                    && s["quotes"].as_array().is_some_and(|quotes| {
                        quotes.iter().any(|q| q["quoteId"] == citation["quoteId"])
                    })
            });
            if !found {
                return Err(
                    "citation is not collected in this task or its earlier session turns".into(),
                );
            }
        }
    }
    // 立即汇报可能只使用同会话已有证据，没有本轮工具调用；有效报告仍须有
    // 可归档的 TaskRun，不能为了通过外键而丢掉插话后的最终结论。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    ensure_task(storage, task, now)?;
    storage
        .save_research_report(task, report)
        .map_err(|e| e.to_string())
}

/// 仅执行工具出现时创建 TaskRun，闲聊/记忆读取不创建伪任务。
pub fn ensure_task(storage: &mut Storage, task: &str, time: i64) -> Result<(), String> {
    if storage
        .load_task(task)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok(());
    }
    storage
        .persist_task_event(
            TaskSnapshot {
                task_id: task.into(),
                task_run_id: format!("run_{task}"),
                trace_id: format!("trace_{task}"),
                lifecycle: TaskLifecycle::Created,
                title: Some("工具执行".into()),
                current_step: None,
                checkpoint: None,
                last_event_sequence: 0,
                created_at_ms: time,
                updated_at_ms: time,
            },
            NewTaskEvent {
                event_id: format!("evt_{task}_created"),
                event_kind: "task.created".into(),
                payload: json!({"source":"execution_tool"}),
                occurred_at_ms: time,
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_progress(
    storage: &mut Storage,
    task: &str,
    payload: Value,
    time: i64,
) -> Result<(), String> {
    ensure_task(storage, task, time)?;
    let mut snapshot = storage
        .load_task(task)
        .map_err(|e| e.to_string())?
        .ok_or("task missing")?;
    snapshot.current_step = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::to_owned);
    snapshot.updated_at_ms = time;
    // 复用生命周期规则，进度事件不能复活取消/完成的任务或越过 unknown。
    if snapshot.lifecycle == TaskLifecycle::Created {
        transition(storage, task, TaskLifecycle::Understanding, time)?;
        transition(storage, task, TaskLifecycle::Running, time)?;
        snapshot = storage
            .load_task(task)
            .map_err(|e| e.to_string())?
            .ok_or("task missing")?;
        snapshot.current_step = payload
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned);
    } else if matches!(
        snapshot.lifecycle,
        TaskLifecycle::Paused | TaskLifecycle::NeedsUser | TaskLifecycle::WaitingConfirmation
    ) {
        transition(storage, task, TaskLifecycle::Running, time)?;
        snapshot = storage
            .load_task(task)
            .map_err(|e| e.to_string())?
            .ok_or("task missing")?;
        snapshot.current_step = payload
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned);
    } else if snapshot.lifecycle != TaskLifecycle::Running {
        return Err("task cannot accept execution progress in current lifecycle".into());
    }
    let sequence = snapshot.last_event_sequence + 1;
    storage
        .persist_task_event(
            snapshot,
            NewTaskEvent {
                event_id: format!("evt_{task}_{sequence}"),
                event_kind: "research.progress".into(),
                payload,
                occurred_at_ms: time,
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 持有 Storage 的桌面入口也使用 TaskRuntime 的纯规则；不另造状态机。
pub fn transition(
    storage: &mut Storage,
    task: &str,
    to: TaskLifecycle,
    time: i64,
) -> Result<(), String> {
    let mut snapshot = storage
        .load_task(task)
        .map_err(|e| e.to_string())?
        .ok_or("task missing")?;
    let from = snapshot.lifecycle;
    if from == to {
        return Ok(());
    }
    if !crate::TaskStateMachine::can_transition(from, to) {
        return Err(format!("illegal lifecycle transition: {from:?} -> {to:?}"));
    }
    // 调研要求正文证据；其他工具轮次只核验回执，不能强制生成研究报告。
    if to == TaskLifecycle::Completed {
        validate_turn_completion(storage, task)?;
    }
    snapshot.lifecycle = to;
    snapshot.updated_at_ms = time;
    let sequence = snapshot.last_event_sequence + 1;
    storage.persist_task_event(snapshot, NewTaskEvent {
        event_id: format!("evt_{task}_{sequence}"),
        event_kind: "task.lifecycle.changed".into(),
        payload: json!({"from":from,"to":to,"verification":if to == TaskLifecycle::Completed {Some("host_turn_evidence_validation")} else {None}}),
        occurred_at_ms: time,
    }).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn finish_turn(storage: &mut Storage, task: &str, time: i64) -> Result<(), String> {
    let Some(snapshot) = storage.load_task(task).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if snapshot.lifecycle != TaskLifecycle::Running {
        return Ok(());
    }
    if validate_turn_completion(storage, task).is_ok() {
        transition(storage, task, TaskLifecycle::Verifying, time)?;
        transition(storage, task, TaskLifecycle::Completed, time)
    } else {
        transition(storage, task, TaskLifecycle::Failed, time)
    }
}

fn validate_turn_completion(storage: &mut Storage, task: &str) -> Result<(), String> {
    let attempts = storage
        .load_task_attempts(task)
        .map_err(|e| e.to_string())?;
    let sources = storage
        .load_research_sources(task)
        .map_err(|e| e.to_string())?;
    let report = storage
        .load_research_report(task)
        .map_err(|e| e.to_string())?;
    if !sources.is_empty()
        || attempts
            .iter()
            .any(|attempt| attempt.tool_name.starts_with("browser_"))
        || report.is_some()
    {
        return save_report(
            storage,
            &report.ok_or("research completion requires stored report")?,
        );
    }
    if attempts.is_empty()
        || attempts.iter().any(|attempt| {
            attempt.status != semi_os_protocol::ToolAttemptStatus::Succeeded
                || attempt
                    .verification
                    .as_ref()
                    .is_none_or(|value| value["status"] != "passed")
        })
    {
        return Err("completion requires successful verified tool receipts".into());
    }
    // 这里只表示本轮工具操作结束；协作工作流的子 Agent 验收是另一个状态边界。
    Ok(())
}

pub fn save_receipt(storage: &mut Storage, receipt: &ToolExecutionReceipt) -> Result<(), String> {
    if receipt.policy_decision == PolicyDecision::Auto
        && matches!(
            receipt.risk_level,
            ToolRiskLevel::ExternalSideEffect | ToolRiskLevel::Privileged
        )
    {
        return Err("high risk cannot be automatically authorized".into());
    }
    ensure_task(storage, &receipt.task_id, receipt.started_at_ms)?;
    if receipt.policy_decision == PolicyDecision::Approved {
        let approval = receipt.approval.as_ref().ok_or("missing approval")?;
        if approval.payload_digest != receipt.input_digest
            || !(if receipt.tool_name.starts_with("desktop_") {
                storage
                    .desktop_approval_matches(
                        &approval.approval_id,
                        &receipt.task_id,
                        &receipt.tool_name,
                        &receipt.input_digest,
                        Some(&receipt.attempt_id),
                        receipt.started_at_ms,
                    )
                    .map_err(|e| e.to_string())?
            } else {
                storage
                    .validates_research_approval(
                        &approval.approval_id,
                        &receipt.task_id,
                        &receipt.tool_name,
                        &receipt.input_digest,
                    )
                    .map_err(|e| e.to_string())?
            })
        {
            return Err("approval does not match current action".into());
        }
    }
    crate::save_execution_receipt(storage, receipt).map_err(|e| e.to_string())?;
    if let Some(approval) = &receipt.approval {
        storage
            .consume_research_approval(&approval.approval_id, &receipt.attempt_id)
            .map_err(|e| e.to_string())?;
    }
    if receipt.status == semi_os_protocol::ToolAttemptStatus::Unknown {
        let task = storage
            .load_task(&receipt.task_id)
            .map_err(|e| e.to_string())?
            .ok_or("task missing")?;
        if task.lifecycle == TaskLifecycle::Running {
            transition(
                storage,
                &receipt.task_id,
                TaskLifecycle::Unknown,
                receipt.finished_at_ms.unwrap_or(receipt.started_at_ms),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_body_and_rejects_fabricated_citations() {
        let mut storage = Storage::open_in_memory().unwrap();
        let source = json!({"sourceId":"s1","taskId":"task_r","originalUrl":"https://a.test","finalUrl":"https://a.test","title":"A","collectedAtMs":1,"status":"collected","artifactId":"a1","digest":format!("sha256:{:x}", Sha256::digest("中文😀正文".as_bytes())),"text":"中文😀正文","quotes":[{"quoteId":"q1","start":0,"end":4,"text":"中文😀"}]});
        save_source(&mut storage, &source).unwrap();
        assert_eq!(
            storage.load_artifact_text("task_r", "a1").unwrap(),
            Some("中文😀正文".into())
        );
        let mut report = json!({"taskId":"task_r","summary":"结果","claims":[{"text":"结论","citations":[{"sourceId":"s1","quoteId":"fake"}]}],"limitations":[]});
        assert!(save_report(&mut storage, &report).is_err());
        report["claims"][0]["citations"][0]["quoteId"] = json!("q1");
        save_report(&mut storage, &report).unwrap();
        assert!(storage.load_research_report("task_r").unwrap().is_some());
    }

    #[test]
    fn follow_up_report_reuses_only_earlier_evidence_in_its_host_owned_session() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.create_client_session("session_a", "A", 1).unwrap();
        storage.create_client_session("session_b", "B", 1).unwrap();
        for (request, task, session, time) in [
            ("req_a", "task_a", "session_a", 2),
            ("req_follow", "task_follow", "session_a", 3),
            ("req_b", "task_b", "session_b", 4),
        ] {
            storage
                .save_conversation(request, &json!({"sessionId":session,"taskId":task}), time)
                .unwrap();
        }
        let source = json!({"sourceId":"s1","taskId":"task_a","originalUrl":"https://a.test","finalUrl":"https://a.test","title":"A","collectedAtMs":2,"status":"collected","artifactId":"a1","digest":format!("sha256:{:x}", Sha256::digest("证据".as_bytes())),"text":"证据","quotes":[{"quoteId":"q1","start":0,"end":2,"text":"证据"}]});
        save_source(&mut storage, &source).unwrap();
        let mut report = json!({"taskId":"task_follow","summary":"已查到","claims":[{"text":"结论","citations":[{"sourceId":"s1","quoteId":"q1"}]}],"limitations":[]});
        save_report(&mut storage, &report).unwrap();
        assert!(storage
            .load_research_report("task_follow")
            .unwrap()
            .is_some());
        assert!(
            storage
                .load_research_archive()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == "task_follow"
                    && entry["sources"][0]["taskId"] == "task_a")
        );
        report["taskId"] = json!("task_b");
        assert!(save_report(&mut storage, &report).is_err());
        report["taskId"] = json!("task_unbound");
        assert!(save_report(&mut storage, &report).is_err());
        report["taskId"] = json!("task_follow");
        report["claims"][0]["citations"][0]["quoteId"] = json!("fake");
        assert!(save_report(&mut storage, &report).is_err());
        storage
            .save_conversation(
                "req_future",
                &json!({"sessionId":"session_a","taskId":"task_future"}),
                5,
            )
            .unwrap();
        // 旧轮次迟到保存不能把新轮次变成它的“较早证据”。
        storage
            .save_conversation(
                "req_follow",
                &json!({"sessionId":"session_a","taskId":"task_follow"}),
                6,
            )
            .unwrap();
        let mut future_source = source;
        future_source["taskId"] = json!("task_future");
        future_source["sourceId"] = json!("s_future");
        future_source["artifactId"] = json!("a_future");
        save_source(&mut storage, &future_source).unwrap();
        report["claims"][0]["citations"][0] = json!({"sourceId":"s_future","quoteId":"q1"});
        assert!(save_report(&mut storage, &report).is_err());
    }

    #[test]
    fn policy_binds_inputs_and_classifies_url_path_not_hostname() {
        assert_eq!(url_risk("https://send.example/docs").unwrap(), "read");
        assert_eq!(
            url_risk("https://example.com/%64elete").unwrap(),
            "external_side_effect"
        );
        assert!(url_risk("https://user:secret@example.com/").is_err());
        let raw = r#"{"url":"https://example.com/docs"}"#;
        let mut request = json!({"toolName":"browser_open","riskLevel":"read","inputJson":raw,"inputDigest":format!("sha256:{:x}",Sha256::digest(raw.as_bytes()))});
        validate_policy(&request).unwrap();
        request["inputJson"] = json!(r#"{"url":"https://example.com/delete"}"#);
        assert!(validate_policy(&request).is_err());
    }

    #[test]
    fn collaboration_controls_match_registered_tool_risk() {
        let raw = r#"{"workflowId":"workflow_test"}"#;
        for tool in [
            "workflow_stop",
            "workflow_resume_run",
            "workflow_steer",
            "workflow_dispatch",
        ] {
            let mut value = json!({"toolName":tool,"riskLevel":"local_write","inputJson":raw,
                "inputDigest":format!("sha256:{:x}",Sha256::digest(raw.as_bytes()))});
            validate_policy(&value).unwrap();
            value["riskLevel"] = json!("read");
            assert!(validate_policy(&value).is_err());
        }
    }

    #[test]
    fn progress_cannot_revive_cancelled_task_or_complete_without_report() {
        let mut storage = Storage::open_in_memory().unwrap();
        record_progress(&mut storage, "task_state", json!({"label":"搜索"}), 1).unwrap();
        assert_eq!(
            storage.load_task("task_state").unwrap().unwrap().lifecycle,
            TaskLifecycle::Running
        );
        assert!(transition(&mut storage, "task_state", TaskLifecycle::Completed, 2).is_err());
        transition(&mut storage, "task_state", TaskLifecycle::Cancelled, 3).unwrap();
        assert!(record_progress(&mut storage, "task_state", json!({"label":"迟到"}), 4).is_err());
    }
}
