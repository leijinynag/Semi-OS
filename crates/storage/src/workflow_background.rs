use crate::{
    workflow_dto::WorkflowDecisionInput, Storage, StorageError, StorageResult, WorkflowCheckpoint,
    WorkflowClaimResult, WorkflowDecisionActor, WorkflowDecisionResult, WorkflowDecisionValue,
    WorkflowEventRecord, WorkflowSnapshotDto,
};
use rusqlite::{params, OptionalExtension};
use semi_os_protocol::WorkflowPlan;
use serde_json::{json, Value};

fn invalid(message: &str) -> StorageError {
    StorageError::InvalidWorkflow(message.into())
}

fn validate_claim_events(events: &[WorkflowEventRecord], sequence: i64) -> StorageResult<()> {
    if sequence <= 0
        || events.last().map(|event| event.sequence) != Some(sequence)
        || events.iter().any(|event| event.sequence <= 0)
        || events
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
    {
        return Err(invalid("invalid claimed event sequence"));
    }
    Ok(())
}

fn checkpoint_fingerprint(checkpoint_json: &str) -> StorageResult<Option<String>> {
    let checkpoint: WorkflowCheckpoint = serde_json::from_str(checkpoint_json)?;
    Ok(checkpoint
        .data
        .get("progressFingerprint")
        .and_then(Value::as_str)
        .map(str::to_owned))
}

impl Storage {
    /// 单领取者 + 租约，检查点和游标原子提交。超时的在途轮次只能对账，不能重放。
    pub fn claim_workflow(
        &mut self,
        id: &str,
        owner: &str,
        now: i64,
    ) -> StorageResult<WorkflowClaimResult> {
        if owner.is_empty() || owner.len() > 160 {
            return Err(invalid("invalid coordinator owner"));
        }
        let snapshot = self
            .load_workflow_dto(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if snapshot.status != "approved" {
            return Ok(WorkflowClaimResult::Unclaimed { needs_user: false });
        }
        let grant = self
            .workflow_grant_dto(id)?
            .ok_or_else(|| invalid("missing user grant"))?;
        if grant.intent_version != snapshot.plan.intent_version {
            return Err(invalid("stale grant"));
        }
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO workflow_coordinators(workflow_id) VALUES(?1) ON CONFLICT DO NOTHING",
            [id],
        )?;
        let (current,lease,claimed,consumed,state,checkpoint):(Option<String>,i64,i64,i64,String,Option<String>)=
            tx.query_row("SELECT owner,lease_until_ms,claimed_sequence,consumed_sequence,execution_status,checkpoint_json FROM workflow_coordinators WHERE workflow_id=?1",[id],
                |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?;
        // 先校验持久检查点和事件，再取得租约；损坏数据不能留下新的在途领取。
        let checkpoint: Option<WorkflowCheckpoint> = checkpoint
            .map(|raw| serde_json::from_str(&raw))
            .transpose()?;
        if checkpoint
            .as_ref()
            .is_some_and(|cp| cp.session_id != format!("coordinator_{id}"))
        {
            return Err(invalid("checkpoint belongs to another workflow"));
        }
        if current.is_some() {
            if lease > now && current.as_deref() != Some(owner) {
                return Ok(WorkflowClaimResult::Unclaimed { needs_user: false });
            }
            if lease > now && current.as_deref() == Some(owner) {
                let mut query=tx.prepare("SELECT event_json FROM workflow_events WHERE workflow_id=?1 AND sequence>?2 AND sequence<=?3 AND json_extract(event_json,'$.kind') NOT IN ('run.activity','coordinator.updated') ORDER BY sequence")?;
                let raw = query
                    .query_map(params![id, consumed, claimed], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                let events = raw
                    .into_iter()
                    .map(|raw| serde_json::from_str::<WorkflowEventRecord>(&raw))
                    .collect::<Result<Vec<_>, _>>()?;
                validate_claim_events(&events, claimed)?;
                return Ok(WorkflowClaimResult::Claimed {
                    sequence: claimed,
                    snapshot: Box::new(snapshot),
                    events,
                    checkpoint,
                });
            }
            if claimed > consumed {
                tx.execute("UPDATE workflow_coordinators SET execution_status='needs_user',reason='协调轮次结果未知，请核对后继续',owner=NULL WHERE workflow_id=?1",[id])?;
                tx.commit()?;
                return Ok(WorkflowClaimResult::Unclaimed { needs_user: true });
            }
        }
        if state == "needs_user" || state == "completed" {
            return Ok(WorkflowClaimResult::Unclaimed { needs_user: false });
        }
        let events: Vec<WorkflowEventRecord> = {
            let mut query=tx.prepare("SELECT event_json FROM workflow_events WHERE workflow_id=?1 AND sequence>?2 AND json_extract(event_json,'$.kind') NOT IN ('run.activity','coordinator.updated') ORDER BY sequence LIMIT 100")?;
            let raw = query
                .query_map(params![id, consumed], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            raw.into_iter()
                .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
                .collect::<StorageResult<_>>()?
        };
        if events.is_empty() {
            return Ok(WorkflowClaimResult::Unclaimed { needs_user: false });
        }
        let sequence = events
            .last()
            .map(|event| event.sequence)
            .ok_or_else(|| invalid("invalid event"))?;
        validate_claim_events(&events, sequence)?;
        tx.execute("UPDATE workflow_coordinators SET owner=?2,lease_until_ms=?3,claimed_sequence=?4,execution_status='coordinating',last_activity_ms=?5 WHERE workflow_id=?1",
            params![id,owner,now+90_000,sequence,now])?;
        tx.commit()?;
        Ok(WorkflowClaimResult::Claimed {
            sequence,
            snapshot: Box::new(snapshot),
            events,
            checkpoint,
        })
    }

    pub fn renew_workflow_claim(&mut self, id: &str, owner: &str, now: i64) -> StorageResult<()> {
        let changed=self.connection.execute("UPDATE workflow_coordinators SET lease_until_ms=?3 WHERE workflow_id=?1 AND owner=?2 AND lease_until_ms>?4",
            params![id,owner,now+90_000,now])?;
        if changed != 1 {
            return Err(invalid("coordinator lease lost"));
        }
        Ok(())
    }

    pub fn finish_workflow_claim(
        &mut self,
        id: &str,
        owner: &str,
        sequence: i64,
        checkpoint: &WorkflowCheckpoint,
        progress: bool,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let checkpoint_json = serde_json::to_string(checkpoint)?;
        if checkpoint_json.len() > 1_048_576 || checkpoint.session_id != format!("coordinator_{id}")
        {
            return Err(invalid("invalid coordinator checkpoint"));
        }
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let completed = snapshot["integration"]["status"] == "verified";
        let unknown = snapshot["runs"].as_array().is_some_and(|runs| {
            runs.iter().any(|run| {
                run["intentVersion"] == snapshot["plan"]["intentVersion"]
                    && run["status"] == "unknown"
            })
        });
        let tx = self.connection.transaction()?;
        let saved:(i64,Option<String>)=tx.query_row("SELECT consumed_sequence,checkpoint_json FROM workflow_coordinators WHERE workflow_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?)))?;
        if saved.0 == sequence && saved.1.as_deref() == Some(&checkpoint_json) {
            return crate::workflow_dto::decode_snapshot(snapshot);
        }
        // 是否有实质进展来自持久事件，不接受 Worker 用 true 绕过保护。
        let meaningful:i64=tx.query_row("SELECT count(*) FROM workflow_events WHERE workflow_id=?1 AND sequence>?2
            AND json_extract(event_json,'$.kind') NOT IN ('run.activity','run.health','coordinator.updated')",
            params![id,sequence],|row|row.get(0))?;
        let fingerprint_changed = match saved.1.as_deref() {
            Some(previous) => {
                match (
                    checkpoint_fingerprint(previous)?,
                    checkpoint_fingerprint(&checkpoint_json)?,
                ) {
                    // 旧检查点没有指纹时，仍允许持久事件证明进展；没有事件时
                    // `meaningful > 0` 会阻止模型仅凭 progress=true 绕过保护。
                    (None, None) => true,
                    (Some(before), Some(after)) => before != after,
                    // 新检查点缺失指纹不能覆盖已有的可验证进度标记。
                    (Some(_), None) => false,
                    (None, Some(_)) => true,
                }
            }
            None => true,
        };
        let progress = progress && meaningful > 0 && fingerprint_changed;
        let max_no_progress_turns = snapshot["plan"]["executionBudget"]["maxNoProgressTurns"]
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("invalid workflow execution budget"))?;
        let changed=tx.execute("UPDATE workflow_coordinators SET consumed_sequence=?3,checkpoint_json=?4,owner=NULL,lease_until_ms=0,
            no_progress=CASE WHEN ?5 THEN 0 ELSE no_progress+1 END,last_activity_ms=?6
            WHERE workflow_id=?1 AND owner=?2 AND claimed_sequence=?3 AND lease_until_ms>?6",
            params![id,owner,sequence,checkpoint_json,progress,now])?;
        if changed != 1 {
            return Err(invalid("stale coordinator receipt"));
        }
        tx.execute("UPDATE workflow_coordinators SET execution_status=CASE WHEN execution_status='needs_user' THEN 'needs_user' WHEN ?3 THEN 'needs_user' WHEN ?2 THEN 'completed' WHEN no_progress>=?4 THEN 'needs_user' ELSE 'running' END,
            reason=CASE WHEN execution_status='needs_user' THEN reason WHEN ?3 THEN '存在未核对的执行结果' WHEN no_progress>=?4 AND NOT ?2 THEN '连续多轮协调没有实质进展' ELSE NULL END WHERE workflow_id=?1",params![id,completed,unknown,max_no_progress_turns])?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    pub fn fail_workflow_claim(
        &mut self,
        id: &str,
        owner: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        self.connection.execute("UPDATE workflow_coordinators SET owner=NULL,lease_until_ms=0,execution_status='needs_user',
            reason='协调执行未确认，检查点与工作区保留，请核对后恢复',last_activity_ms=?3 WHERE workflow_id=?1 AND owner=?2",params![id,owner,now])?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 领取回执也可能丢失；仅标记本领取者或尚未领取的工作流，不能夺取别人的租约。
    pub fn unavailable_workflow_coordinator(
        &mut self,
        id: &str,
        owner: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        self.connection.execute(
            "INSERT INTO workflow_coordinators(workflow_id) SELECT workflow_id FROM workflows
            WHERE workflow_id=?1 AND status='approved' ON CONFLICT DO NOTHING",
            [id],
        )?;
        self.connection.execute("UPDATE workflow_coordinators SET owner=NULL,lease_until_ms=0,execution_status='needs_user',
            reason='协调通信重试耗尽，请检查连接并核对后恢复',last_activity_ms=?3
            WHERE workflow_id=?1 AND execution_status!='completed' AND (owner IS NULL OR owner=?2)",params![id,owner,now])?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 启动请求先保存再发送给 Provider；未启动与可能已执行不能混为一谈。
    pub fn mark_workflow_run_phase(
        &mut self,
        run: &str,
        phase: &str,
        now: i64,
    ) -> StorageResult<()> {
        if !["start_requested", "executing", "saved"].contains(&phase) {
            return Err(invalid("invalid execution phase"));
        }
        let previous: Option<String> = self
            .connection
            .query_row(
                "SELECT phase FROM workflow_run_phases WHERE run_id=?1",
                [run],
                |row| row.get(0),
            )
            .optional()?;
        let legal = matches!(
            (previous.as_deref(), phase),
            (Some("not_started"), "start_requested")
                | (Some("start_requested"), "executing")
                | (Some("executing" | "start_requested"), "saved")
        );
        if !legal && previous.as_deref() != Some(phase) {
            return Err(invalid("invalid phase transition"));
        }
        self.connection.execute(
            "UPDATE workflow_run_phases SET phase=?2,updated_at_ms=?3 WHERE run_id=?1",
            params![run, phase, now],
        )?;
        Ok(())
    }

    pub fn workflow_run_phase(&self, run: &str) -> StorageResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT phase FROM workflow_run_phases WHERE run_id=?1",
                [run],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// 仅原生用户入口使用。恢复前要求未知执行已核对；没有新需求或新授权。
    pub fn resume_workflow_coordinator(
        &mut self,
        id: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if snapshot["status"] != "approved"
            || snapshot["runs"].as_array().is_some_and(|runs| {
                runs.iter().any(|run| {
                    run["intentVersion"] == snapshot["plan"]["intentVersion"]
                        && run["status"] == "unknown"
                })
            })
        {
            return Err(invalid("reconcile executions and approval before resuming"));
        }
        if snapshot["background"]["requests"]
            .as_array()
            .is_some_and(|requests| {
                requests
                    .iter()
                    .any(|request| request["status"] == "needs_user")
            })
        {
            return Err(invalid("answer pending user questions before resuming"));
        }
        let changed = self.connection.execute("UPDATE workflow_coordinators SET owner=NULL,lease_until_ms=0,
            consumed_sequence=claimed_sequence,execution_status='running',no_progress=0,reason=NULL,last_activity_ms=?2
            WHERE workflow_id=?1 AND owner IS NULL",params![id,now])?;
        if changed != 1 {
            return Err(invalid("coordinator still active"));
        }
        self.record_workflow_event(
            id,
            "user.coordinator_resumed",
            "用户核对后恢复协调；不重放旧事件",
            now,
        )
    }

    /// 新意图先原子撤销授权并持久化，再通知 Worker 停止；离线 Worker 不能继续派单。
    pub fn change_workflow_intent(
        &mut self,
        id: &str,
        text: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        if text.trim().is_empty() || text.len() > 8000 {
            return Err(invalid("invalid user instruction"));
        }
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if ["cancelled", "rejected"].contains(&snapshot["status"].as_str().unwrap_or("")) {
            return Err(invalid("workflow is closed"));
        }
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE workflows SET status='needs_revision' WHERE workflow_id=?1",
            [id],
        )?;
        tx.execute("DELETE FROM workflow_grants WHERE workflow_id=?1", [id])?;
        tx.execute("UPDATE workflow_coordinators SET execution_status='needs_user',reason='用户修改要求，等待新计划批准' WHERE workflow_id=?1",[id])?;
        super::workflow::append_event(&tx, &plan, "user.intent_changed", text.trim(), now)?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    pub fn register_workflow_decision(
        &mut self,
        id: &str,
        run: &str,
        request: &str,
        kind: &str,
        input_dto: &WorkflowDecisionInput,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let input = serde_json::to_value(input_dto)?;
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if !["clarification", "plan"].contains(&kind)
            || request.is_empty()
            || request.len() > 160
            || !input.is_object()
            || input.to_string().len() > 32_000
            || snapshot["status"] != "approved"
            || !snapshot["runs"].as_array().is_some_and(|runs| {
                runs.iter().any(|value| {
                    value["runId"] == run
                        && value["status"] == "running"
                        && value["intentVersion"] == snapshot["plan"]["intentVersion"]
                })
            })
        {
            return Err(invalid("invalid decision request"));
        }
        // 写入与查询使用相同字段契约，不能让不可解码的问题污染整个工作流快照。
        if kind == "clarification" && !input["questions"].is_array() {
            return Err(invalid("missing structured questions"));
        }
        if kind == "clarification"
            && !input["questions"].as_array().is_some_and(|questions| {
                !questions.is_empty()
                    && questions.len() <= 4
                    && questions.iter().all(|q| {
                        q["question"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 4000)
                    })
            })
        {
            return Err(invalid("invalid structured questions"));
        }
        let previous:Option<String>=self.connection.query_row("SELECT request_json FROM workflow_decision_requests WHERE workflow_id=?1 AND request_id=?2",
            params![id,request],|row|row.get(0)).optional()?;
        if let Some(previous) = previous {
            let same:bool=self.connection.query_row("SELECT run_id=?3 AND kind=?4 FROM workflow_decision_requests WHERE workflow_id=?1 AND request_id=?2",
                params![id,request,run,kind],|row|row.get(0))?;
            if serde_json::from_str::<Value>(&previous)? != input || !same {
                return Err(invalid("decision request id reused"));
            }
            return crate::workflow_dto::decode_snapshot(snapshot);
        }
        self.connection.execute("INSERT INTO workflow_decision_requests(workflow_id,request_id,run_id,intent_version,kind,request_json) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id,request,run,snapshot["plan"]["intentVersion"].as_u64(),kind,input.to_string()])?;
        self.record_workflow_event(
            id,
            "delegate.requested",
            "子 Agent 请求范围内计划/实现澄清；涉及用户意图须转交用户",
            now,
        )
    }

    pub fn workflow_decision_result(
        &self,
        id: &str,
        request: &str,
    ) -> StorageResult<Option<WorkflowDecisionResult>> {
        let raw:Option<String>=self.connection.query_row("SELECT decision_json FROM workflow_delegate_decisions WHERE workflow_id=?1 AND request_id=?2",
            params![id,request],|row|row.get(0)).optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    /// 代理决策不产生真人批准。仅允许已托管工作项的实现澄清或范围内子计划。
    pub fn save_delegate_decision(
        &mut self,
        id: &str,
        run: &str,
        request: &str,
        kind: &str,
        decision_dto: &WorkflowDecisionValue,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let decision = serde_json::to_value(decision_dto)?;
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        if snapshot["status"] != "approved"
            || self.workflow_grant(id)?.is_none()
            || !["clarification", "plan"].contains(&kind)
            || request.is_empty()
            || request.len() > 160
            || decision.to_string().len() > 32_000
        {
            return Err(invalid("decision outside delegated scope"));
        }
        let runs = snapshot["runs"]
            .as_array()
            .ok_or_else(|| invalid("missing runs"))?;
        if !runs.iter().any(|value| {
            value["runId"] == run
                && value["intentVersion"] == plan.intent_version
                && value["status"] == "running"
        }) {
            return Err(invalid("stale decision request"));
        }
        // 回执可能丢失：只有完全相同的决定才幂等，不能覆盖已经作出的决定。
        let saved = self.workflow_decision_result(id, request)?;
        if let Some(saved) = saved {
            if saved.actor == WorkflowDecisionActor::Agent
                && serde_json::to_value(&saved.kind)? == kind
                && saved.run_id == run
                && saved.value == *decision_dto
            {
                return crate::workflow_dto::decode_snapshot(snapshot);
            }
            return Err(invalid("decision already recorded"));
        }
        let pending:Option<(String,String,String,u32)>=self.connection.query_row(
            "SELECT run_id,kind,status,intent_version FROM workflow_decision_requests WHERE workflow_id=?1 AND request_id=?2",
            params![id,request],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        if pending
            != Some((
                run.into(),
                kind.into(),
                "pending".into(),
                plan.intent_version,
            ))
        {
            return Err(invalid("request is not pending"));
        }
        let authority = decision["authority"]
            .as_str()
            .ok_or_else(|| invalid("missing decision authority"))?;
        if !["implementation_detail", "needs_user"].contains(&authority)
            || !decision["reason"]
                .as_str()
                .is_some_and(|reason| !reason.trim().is_empty() && reason.len() <= 4000)
        {
            return Err(invalid("invalid delegated decision"));
        }
        if authority == "implementation_detail"
            && kind == "clarification"
            && !decision["answers"].as_object().is_some_and(|answers| {
                !answers.is_empty() && answers.values().all(|value| value.is_string())
            })
        {
            return Err(invalid("missing structured answers"));
        }
        if authority == "implementation_detail" && kind == "clarification" {
            let raw:String=self.connection.query_row("SELECT request_json FROM workflow_decision_requests WHERE workflow_id=?1 AND request_id=?2",
                params![id,request],|row|row.get(0))?;
            let input: Value = serde_json::from_str(&raw)?;
            let answers = decision["answers"]
                .as_object()
                .ok_or_else(|| invalid("missing answers"))?;
            let questions = input["questions"]
                .as_array()
                .ok_or_else(|| invalid("missing questions"))?;
            if answers.len() != questions.len()
                || !questions.iter().all(|q| {
                    q["question"].as_str().is_some_and(|key| {
                        answers
                            .get(key)
                            .and_then(Value::as_str)
                            .is_some_and(|answer| !answer.trim().is_empty() && answer.len() <= 4000)
                    })
                })
            {
                return Err(invalid("answers do not match requested questions"));
            }
        }
        if authority == "implementation_detail"
            && kind == "plan"
            && decision["approved"].as_bool().is_none()
        {
            return Err(invalid("missing plan decision"));
        }
        let value = json!({"actor":"agent","kind":kind,"runId":run,"value":decision});
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO workflow_delegate_decisions(workflow_id,request_id,intent_version,decision_json,decided_at_ms) VALUES(?1,?2,?3,?4,?5)",
            params![id,request,plan.intent_version,value.to_string(),now])?;
        tx.execute("UPDATE workflow_decision_requests SET status=?3 WHERE workflow_id=?1 AND request_id=?2",
            params![id,request,if authority=="needs_user" {"needs_user"}else{"answered"}])?;
        if authority == "needs_user" {
            tx.execute("UPDATE workflow_coordinators SET execution_status='needs_user',reason=?2 WHERE workflow_id=?1",params![id,decision["reason"].as_str()])?;
        }
        super::workflow::append_event(
            &tx,
            &plan,
            "delegate.decided",
            &format!("{run} · {kind} · 主 Pi 决策"),
            now,
        )?;
        tx.execute("INSERT INTO workflow_evidence_history(workflow_id,sequence,kind,evidence_json,recorded_at_ms)
            SELECT workflow_id,last_sequence,'delegate.decision',?2,?3 FROM workflows WHERE workflow_id=?1",
            params![id,value.to_string(),now])?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 仅客户端真人入口调用。答案只解决已有问题，不授予新增权限或扩大计划范围。
    pub fn answer_workflow_decision(
        &mut self,
        id: &str,
        request: &str,
        answer_dto: &WorkflowDecisionValue,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let answer = serde_json::to_value(answer_dto)?;
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        if snapshot["status"] != "approved" || answer.to_string().len() > 32_000 {
            return Err(invalid("workflow is not approved"));
        }
        // 原生调用回执丢失时可安全重试同一答复，但不能借旧 requestId 改写已回答内容。
        let saved = self.workflow_decision_result(id, request)?;
        if let Some(saved) = saved.filter(|saved| saved.actor == WorkflowDecisionActor::User) {
            let intent: u32=self.connection.query_row(
                "SELECT intent_version FROM workflow_delegate_decisions WHERE workflow_id=?1 AND request_id=?2",
                params![id,request],|row|row.get(0))?;
            if intent == plan.intent_version && saved.value == *answer_dto {
                return crate::workflow_dto::decode_snapshot(snapshot);
            }
            return Err(invalid("user answer already recorded"));
        }
        let pending = snapshot["background"]["requests"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["requestId"] == request && item["status"] == "needs_user")
            })
            .ok_or_else(|| invalid("no pending user decision"))?;
        let kind = pending["kind"]
            .as_str()
            .ok_or_else(|| invalid("missing kind"))?;
        if kind == "clarification" {
            let questions = pending["input"]["questions"]
                .as_array()
                .ok_or_else(|| invalid("missing questions"))?;
            let answers = answer["answers"]
                .as_object()
                .ok_or_else(|| invalid("missing answers"))?;
            if answers.len() != questions.len()
                || !questions.iter().all(|q| {
                    q["question"].as_str().is_some_and(|key| {
                        answers
                            .get(key)
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 4000)
                    })
                })
            {
                return Err(invalid("answers do not match questions"));
            }
        } else if answer["approved"].as_bool().is_none() {
            return Err(invalid("missing plan answer"));
        }
        let value = json!({"actor":"user","kind":kind,"runId":pending["runId"],"value":answer});
        let tx = self.connection.transaction()?;
        tx.execute("UPDATE workflow_delegate_decisions SET decision_json=?3,decided_at_ms=?4 WHERE workflow_id=?1 AND request_id=?2",
            params![id,request,value.to_string(),now])?;
        tx.execute("UPDATE workflow_decision_requests SET status='answered' WHERE workflow_id=?1 AND request_id=?2",params![id,request])?;
        super::workflow::append_event(
            &tx,
            &plan,
            "user.delegate_answered",
            "用户回答子 Agent 请求；未扩大权限",
            now,
        )?;
        tx.execute("INSERT INTO workflow_evidence_history(workflow_id,sequence,kind,evidence_json,recorded_at_ms)
            SELECT workflow_id,last_sequence,'delegate.decision',?2,?3 FROM workflows WHERE workflow_id=?1",
            params![id,value.to_string(),now])?;
        // 其他未回答问题或未知执行仍阻止恢复。
        tx.execute("UPDATE workflow_coordinators SET execution_status='running',no_progress=0,reason=NULL
            WHERE workflow_id=?1
            AND NOT EXISTS (SELECT 1 FROM workflow_decision_requests q JOIN agent_runs r ON r.run_id=q.run_id
                WHERE q.workflow_id=?1 AND q.intent_version=?2 AND q.status='needs_user'
                AND json_extract(r.run_json,'$.status')='running')
            AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_id=?1
                AND json_extract(r.run_json,'$.intentVersion')=?2 AND json_extract(r.run_json,'$.status')='unknown')",
            params![id,plan.intent_version])?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }
}
