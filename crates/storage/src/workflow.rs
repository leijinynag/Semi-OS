use crate::{Storage, StorageError, StorageResult, WorkflowSnapshotDto};
use rusqlite::{params, OptionalExtension, Transaction};
use semi_os_protocol::{
    validate_workflow_plan, AgentRun, IntegrationResult, ReviewFinding, WorkflowApplication,
    WorkflowPlan,
};
use serde_json::json;

fn invalid(message: &str) -> StorageError {
    StorageError::InvalidWorkflow(message.into())
}
fn revision_valid(s: &str) -> bool {
    matches!(s.len(), 40 | 64)
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identity_valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn digest_valid(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn save_evidence_history(
    tx: &Transaction<'_>,
    id: &str,
    kind: &str,
    value: &str,
    now: i64,
) -> StorageResult<()> {
    tx.execute("INSERT INTO workflow_evidence_history(workflow_id,sequence,kind,evidence_json,recorded_at_ms)
        SELECT workflow_id,last_sequence,?2,?3,?4 FROM workflows WHERE workflow_id=?1",
        params![id,kind,value,now])?;
    Ok(())
}
/// 当前快照和追加事件必须同事务落盘；崩溃不能留下 UI 已批准但数据库未批准。
pub(super) fn append_event(
    tx: &Transaction<'_>,
    plan: &WorkflowPlan,
    kind: &str,
    summary: &str,
    now: i64,
) -> StorageResult<()> {
    let sequence: i64 = tx.query_row(
        "UPDATE workflows SET last_sequence=last_sequence+1 WHERE workflow_id=?1 RETURNING last_sequence",
        [&plan.workflow_id], |row| row.get(0),
    )?;
    let event = json!({
        "eventId": format!("evt_{}_{}",plan.workflow_id,sequence),
        "sequence":sequence,"kind":kind,"summary":summary,"occurredAtMs":now,
        "planVersion":plan.version,"intentVersion":plan.intent_version,
    });
    tx.execute(
        "INSERT INTO workflow_events(workflow_id,sequence,event_id,event_json) VALUES(?1,?2,?3,?4)",
        params![
            plan.workflow_id,
            sequence,
            event["eventId"].as_str(),
            event.to_string()
        ],
    )?;
    Ok(())
}

impl Storage {
    fn guard_application(&self, id: &str) -> StorageResult<()> {
        let active: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM workflow_applications WHERE workflow_id=?1 AND status IN ('approved','executing','unknown'))",
            [id], |row|row.get(0))?;
        if active {
            return Err(invalid(
                "source application pending or unknown; reconcile it before new operations",
            ));
        }
        Ok(())
    }
    /// 独立用户批准绑定精确目标；后续意图、执行或成果变化使其失效。
    fn validate_application(&self, request: &WorkflowApplication) -> StorageResult<WorkflowPlan> {
        let snapshot = self
            .load_workflow(&request.workflow_id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        if !identity_valid(&request.application_id)
            || !revision_valid(&request.expected_head)
            || !revision_valid(&request.revision)
            || !request.expected_ref.starts_with("refs/heads/")
            || request
                .expected_ref
                .chars()
                .any(|c| c.is_whitespace() || "~^:?*[\\".contains(c))
            || snapshot["status"] != "approved"
            || plan.version != request.version
            || snapshot["digest"] != request.digest
            || plan.repository != request.repository
            || snapshot["integration"]["status"] != "verified"
            || snapshot["integration"]["revision"] != request.revision
            || snapshot["integration"]["workspace"] != request.workspace
            || snapshot["runs"].as_array().is_some_and(|runs| {
                runs.iter().any(|run| {
                    run["intentVersion"] == plan.intent_version
                        && ["queued", "running", "blocked", "unknown"]
                            .contains(&run["status"].as_str().unwrap_or(""))
                })
            })
        {
            return Err(invalid(
                "application requires the current verified idle workflow",
            ));
        }
        Ok(plan)
    }
    pub fn approve_workflow_application(
        &mut self,
        request: &WorkflowApplication,
        now: i64,
    ) -> StorageResult<()> {
        let plan = self.validate_application(request)?;
        let tx = self.connection.transaction()?;
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workflow_applications WHERE workflow_id=?1 AND status IN ('approved','executing','unknown'))",
            [&request.workflow_id], |row| row.get(0))?;
        if pending {
            return Err(invalid(
                "an application is already pending or requires reconciliation",
            ));
        }
        tx.execute("INSERT INTO workflow_applications(application_id,workflow_id,request_json,status,updated_at_ms) VALUES(?1,?2,?3,'approved',?4)",
            params![request.application_id,request.workflow_id,serde_json::to_string(request)?,now])?;
        append_event(
            &tx,
            &plan,
            "application.approved",
            &format!(
                "用户批准应用 {} 到 {}（{}）",
                request.revision, request.expected_ref, request.expected_head
            ),
            now,
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Worker 只能一次性消费既有用户批准，不能自行创建、替换或重复执行它。
    pub fn begin_workflow_application(
        &mut self,
        id: &str,
        now: i64,
    ) -> StorageResult<WorkflowApplication> {
        let raw: String = self.connection.query_row("SELECT request_json FROM workflow_applications WHERE application_id=?1 AND status='approved'",[id],|row| row.get(0))?;
        let request: WorkflowApplication = serde_json::from_str(&raw)?;
        let plan = self.validate_application(&request)?;
        let tx = self.connection.transaction()?;
        if tx.execute("UPDATE workflow_applications SET status='executing',updated_at_ms=?2 WHERE application_id=?1 AND status='approved'",params![id,now])? != 1 {
            return Err(invalid("application already consumed"));
        }
        append_event(
            &tx,
            &plan,
            "application.started",
            &format!("应用 {} · {}", request.expected_ref, request.revision),
            now,
        )?;
        tx.commit()?;
        Ok(request)
    }
    pub fn finish_workflow_application(
        &mut self,
        id: &str,
        applied: bool,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let raw: String = self.connection.query_row("SELECT request_json FROM workflow_applications WHERE application_id=?1 AND status='executing'",[id],|row| row.get(0))?;
        let request: WorkflowApplication = serde_json::from_str(&raw)?;
        let snapshot = self
            .load_workflow(&request.workflow_id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE workflow_applications SET status=?2,updated_at_ms=?3 WHERE application_id=?1",
            params![id, if applied { "applied" } else { "unknown" }, now],
        )?;
        append_event(
            &tx,
            &plan,
            if applied {
                "application.applied"
            } else {
                "application.unknown"
            },
            &format!(
                "{} · {}{}",
                request.expected_ref,
                request.revision,
                if applied {
                    ""
                } else {
                    " · 未确认应用结果，请核对源分支；禁止自动重试"
                }
            ),
            now,
        )?;
        tx.commit()?;
        self.load_workflow_dto(&request.workflow_id)?
            .ok_or_else(|| invalid("missing workflow"))
    }
    pub fn save_workflow_plan(
        &mut self,
        plan: &WorkflowPlan,
        digest: &str,
        now: i64,
    ) -> StorageResult<()> {
        self.guard_application(&plan.workflow_id)?;
        validate_workflow_plan(plan).map_err(StorageError::InvalidWorkflow)?;
        if !digest_valid(digest) {
            return Err(invalid("invalid plan digest"));
        }
        let tx = self.connection.transaction()?;
        let current: Option<(u32, String, u32)> = tx.query_row(
            "SELECT w.current_version,p.session_id,p.intent_version FROM workflows w JOIN workflow_plans p ON p.workflow_id=w.workflow_id AND p.version=w.current_version WHERE w.workflow_id=?1",
            [&plan.workflow_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?;
        let expected = match current.as_ref() {
            Some((version, _, _)) => version
                .checked_add(1)
                .ok_or_else(|| invalid("version exhausted"))?,
            None => 1,
        };
        if plan.version != expected {
            return Err(invalid("plan version must advance exactly once"));
        }
        if let Some((_, session, intent)) = current {
            if session != plan.session_id || plan.intent_version < intent {
                return Err(invalid("session changed or stale user intent"));
            }
            if plan.intent_version == intent {
                return Err(invalid("new approval scope must advance user intent; use refinement for in-scope changes"));
            }
        }
        // 会话归属由存储校验，不能将后台工作伪挂到不存在的客户端 Session。
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM client_sessions WHERE session_id=?1)",
            [&plan.session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(invalid("unknown client session"));
        }
        tx.execute(
            "INSERT INTO workflow_plans(workflow_id,version,session_id,intent_version,digest,plan_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![plan.workflow_id,plan.version,plan.session_id,plan.intent_version,digest,serde_json::to_string(plan)?,now],
        )?;
        tx.execute(
            "INSERT INTO workflows(workflow_id,current_version,status) VALUES(?1,?2,'awaiting_approval') ON CONFLICT(workflow_id) DO UPDATE SET current_version=excluded.current_version,status='awaiting_approval'",
            params![plan.workflow_id,plan.version],
        )?;
        tx.execute(
            "DELETE FROM workflow_grants WHERE workflow_id=?1",
            [&plan.workflow_id],
        )?;
        tx.execute(
            "DELETE FROM workflow_coordinators WHERE workflow_id=?1",
            [&plan.workflow_id],
        )?;
        // 新用户意图不能继承上一目标的验收快照；历史证据仍在追加表中保留。
        tx.execute(
            "DELETE FROM workflow_evidence WHERE workflow_id=?1",
            [&plan.workflow_id],
        )?;
        append_event(&tx, plan, "plan.submitted", "计划等待用户批准", now)?;
        tx.commit()?;
        Ok(())
    }

    /// 范围内调整继承用户批准边界，而不是允许 Agent 自行批准新目标。
    /// 正在运行时拒绝换图：先停止受影响尝试，历史交付只在原工作项不变时复用。
    pub fn refine_workflow_plan(
        &mut self,
        plan: &WorkflowPlan,
        digest: &str,
        now: i64,
    ) -> StorageResult<()> {
        self.guard_application(&plan.workflow_id)?;
        validate_workflow_plan(plan).map_err(StorageError::InvalidWorkflow)?;
        if !digest_valid(digest) {
            return Err(invalid("invalid plan digest"));
        }
        let snapshot = self
            .load_workflow(&plan.workflow_id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let old: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
        if snapshot["status"] != "approved"
            || Some(plan.version) != old.version.checked_add(1)
            || plan.session_id != old.session_id
            || plan.intent_version != old.intent_version
            || plan.goal != old.goal
            || plan.scope != old.scope
            || plan.acceptance != old.acceptance
            || plan.repository != old.repository
            || plan.baseline_commit != old.baseline_commit
            || plan.authorized_actions != old.authorized_actions
        {
            return Err(invalid("material change requires a new user-approved plan"));
        }
        if runs
            .iter()
            .any(|run| ["queued", "running", "blocked", "unknown"].contains(&run.status.as_str()))
        {
            return Err(invalid(
                "stop or reconcile existing attempts before refining",
            ));
        }
        for run in runs
            .iter()
            .filter(|run| run.intent_version == old.intent_version && run.status == "completed")
        {
            let before = old
                .work_items
                .iter()
                .find(|item| item.work_item_id == run.work_item_id);
            let after = plan
                .work_items
                .iter()
                .find(|item| item.work_item_id == run.work_item_id);
            if let Some(before) = before {
                let Some(after) = after else {
                    return Err(invalid("cannot remove delivered dependency"));
                };
                if before.objective != after.objective
                    || before.role != after.role
                    || before.dependencies != after.dependencies
                    || before.outputs != after.outputs
                    || before.acceptance != after.acceptance
                {
                    return Err(invalid("delivered work item cannot change; add a new item"));
                }
            }
        }
        // 新版本、批准来源及事件同事务保存，不覆盖旧图和旧执行尝试。
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO workflow_plans(workflow_id,version,session_id,intent_version,digest,plan_json,created_at_ms)
            VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![plan.workflow_id,plan.version,plan.session_id,plan.intent_version,digest,serde_json::to_string(plan)?,now])?;
        tx.execute("INSERT INTO workflow_decisions(workflow_id,plan_version,decision,decided_at_ms) VALUES(?1,?2,'approved',?3)",
            params![plan.workflow_id,plan.version,now])?;
        tx.execute(
            "UPDATE workflows SET current_version=?2 WHERE workflow_id=?1",
            params![plan.workflow_id, plan.version],
        )?;
        append_event(
            &tx,
            plan,
            "plan.refined",
            &format!("范围内重分工；授权沿用用户批准版本 v{}", old.version),
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 状态更新必须引用保存过的计划。历史结果允许落盘，但不能启动旧版本的新操作。
    pub fn save_agent_run(
        &mut self,
        run: &AgentRun,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let raw: String = self.connection.query_row(
            "SELECT plan_json FROM workflow_plans WHERE workflow_id=?1 AND version=?2",
            params![run.workflow_id, run.plan_version],
            |row| row.get(0),
        )?;
        let plan: WorkflowPlan = serde_json::from_str(&raw)?;
        let item = plan
            .work_items
            .iter()
            .find(|item| item.work_item_id == run.work_item_id)
            .ok_or_else(|| invalid("unknown work item"))?;
        if run.run_id.is_empty()
            || run.run_id.len() > 160
            || !run
                .run_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || run.attempt == 0
            || run.intent_version != plan.intent_version
            || run.provider != item.provider
            || run.started_at_ms < 0
            || run.ended_at_ms.is_some_and(|n| n < run.started_at_ms)
            || ![
                "queued",
                "running",
                "blocked",
                "completed",
                "failed",
                "cancelled",
                "unknown",
            ]
            .contains(&run.status.as_str())
            || run.summary.as_ref().is_some_and(|s| s.len() > 128_000)
        {
            return Err(invalid("invalid agent run"));
        }
        let previous: Option<String> = self
            .connection
            .query_row(
                "SELECT run_json FROM agent_runs WHERE run_id=?1",
                [&run.run_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let previous: AgentRun = serde_json::from_str(&previous)?;
            if previous.workflow_id != run.workflow_id
                || previous.plan_version != run.plan_version
                || previous.work_item_id != run.work_item_id
                || previous.attempt != run.attempt
                || previous.started_at_ms != run.started_at_ms
                || ["completed", "failed", "cancelled"].contains(&previous.status.as_str())
            {
                return Err(invalid("immutable or terminal run"));
            }
            let legal = match previous.status.as_str() {
                "queued" => [
                    "queued",
                    "running",
                    "blocked",
                    "failed",
                    "cancelled",
                    "unknown",
                ]
                .contains(&run.status.as_str()),
                "running" => [
                    "running",
                    "blocked",
                    "completed",
                    "failed",
                    "cancelled",
                    "unknown",
                ]
                .contains(&run.status.as_str()),
                "blocked" | "unknown" => ["cancelled", "unknown"].contains(&run.status.as_str()),
                _ => false,
            };
            if !legal {
                return Err(invalid("invalid run transition"));
            }
        } else {
            if run.status != "queued" {
                return Err(invalid("new attempt must be queued"));
            }
            let snapshot = self
                .load_workflow(&run.workflow_id)?
                .ok_or_else(|| invalid("missing workflow"))?;
            let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
            let current: Vec<_> = runs
                .iter()
                .filter(|saved| saved.intent_version == run.intent_version)
                .collect();
            let attempts: Vec<_> = current
                .iter()
                .filter(|saved| saved.work_item_id == run.work_item_id)
                .collect();
            if attempts.iter().any(|saved| {
                ["queued", "running", "blocked", "unknown"].contains(&saved.status.as_str())
            }) || run.attempt as usize != attempts.len() + 1
            {
                return Err(invalid("duplicate or unresolved attempt"));
            }
        }
        if ["queued", "running"].contains(&run.status.as_str()) {
            let snapshot = self
                .load_workflow(&run.workflow_id)?
                .ok_or_else(|| invalid("missing workflow"))?;
            self.authorize_work_item(
                &run.workflow_id,
                run.plan_version,
                snapshot["digest"]
                    .as_str()
                    .ok_or_else(|| invalid("missing digest"))?,
                &run.work_item_id,
            )?;
            let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
            // 完成只是交付，不等于验收；依赖必须同时有具体成果版本，不能靠摘要启动。
            for dependency in &item.dependencies {
                let latest = runs.iter().rev().find(|saved| {
                    saved.intent_version == run.intent_version && saved.work_item_id == *dependency
                });
                if !latest
                    .is_some_and(|saved| saved.status == "completed" && saved.revision.is_some())
                {
                    return Err(invalid("dependency has no completed revision"));
                }
            }
            if run.status == "running" {
                let active: i64 = self.connection.query_row(
                    "SELECT COUNT(*) FROM agent_runs WHERE run_id<>?1 AND json_extract(run_json,'$.status')='running'",
                    [&run.run_id], |row| row.get(0),
                )?;
                if active >= 2 {
                    return Err(invalid("child concurrency limit exceeded"));
                }
                if run.workspace.is_none() || run.branch.is_none() || run.baseline_commit.is_none()
                {
                    return Err(invalid("running attempt requires owned workspace"));
                }
            }
        }
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO agent_runs(run_id,workflow_id,plan_version,work_item_id,attempt,run_json) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(run_id) DO UPDATE SET run_json=excluded.run_json",
            params![run.run_id,run.workflow_id,run.plan_version,run.work_item_id,run.attempt,serde_json::to_string(run)?],
        )?;
        tx.execute("INSERT INTO workflow_run_phases(run_id,phase,updated_at_ms) VALUES(?1,'not_started',?2) ON CONFLICT DO NOTHING",
            params![run.run_id,now])?;
        append_event(
            &tx,
            &plan,
            "run.updated",
            &format!("{} · {} · {}", item.title, run.provider_name(), run.status),
            now,
        )?;
        tx.commit()?;
        self.load_workflow_dto(&run.workflow_id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 用户控制写入先于 Worker 通知；拒绝/暂停后即使 Worker 迟到，也无法取得新授权。
    pub fn control_workflow(
        &mut self,
        id: &str,
        control: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        if control == "reconcile_application" {
            let snapshot = self
                .load_workflow(id)?
                .ok_or_else(|| invalid("unknown workflow"))?;
            let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
            let tx = self.connection.transaction()?;
            let executing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workflow_applications WHERE workflow_id=?1 AND status='executing')",[id],|row|row.get(0))?;
            if executing {
                return Err(invalid("application is still executing"));
            }
            if tx.execute("UPDATE workflow_applications SET status='reconciled',updated_at_ms=?2 WHERE workflow_id=?1 AND status IN ('approved','unknown')",params![id,now])? == 0 {
                return Err(invalid("no uncertain application to reconcile"));
            }
            append_event(
                &tx,
                &plan,
                "application.reconciled",
                "用户声明已手工核对源分支；旧应用授权失效，不自动重试",
                now,
            )?;
            tx.commit()?;
            return self
                .load_workflow_dto(id)?
                .ok_or_else(|| invalid("missing workflow"));
        }
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let status = snapshot["status"].as_str().unwrap_or("");
        let next = match control {
            "pause" if !["cancelled", "rejected"].contains(&status) => "paused",
            "cancel" => "cancelled",
            "revise" => "needs_revision",
            "resume" if status == "paused" => {
                let approved: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workflow_decisions WHERE workflow_id=?1 AND plan_version=?2 AND decision='approved')",
                    params![id,snapshot["plan"]["version"].as_u64()], |row| row.get(0),
                )?;
                if approved {
                    "approved"
                } else {
                    "awaiting_approval"
                }
            }
            _ => return Err(invalid("invalid control transition")),
        };
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "UPDATE workflows SET status=?2 WHERE workflow_id=?1",
            params![id, next],
        )?;
        if ["paused", "cancelled", "needs_revision"].contains(&next) {
            tx.execute("UPDATE workflow_coordinators SET execution_status='needs_user',reason=?2 WHERE workflow_id=?1",
                params![id, format!("用户已{}", next)])?;
        }
        if next == "approved" {
            // 主动恢复不能越过待回答的问题或未知执行；需要核对时保留保护状态。
            let unresolved = snapshot["background"]["requests"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["status"] == "needs_user"))
                || snapshot["runs"].as_array().is_some_and(|runs| {
                    runs.iter().any(|run| {
                        run["intentVersion"] == plan.intent_version && run["status"] == "unknown"
                    })
                });
            if !unresolved {
                tx.execute("UPDATE workflow_coordinators SET execution_status='running',no_progress=0,reason=NULL WHERE workflow_id=?1 AND owner IS NULL",[id])?;
            }
        }
        append_event(&tx, &plan, "workflow.controlled", next, now)?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    pub fn record_workflow_event(
        &mut self,
        id: &str,
        kind: &str,
        summary: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        if kind.len() > 160 || summary.is_empty() || summary.len() > 32_000 {
            return Err(invalid("invalid workflow event"));
        }
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("missing workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let tx = self.connection.transaction()?;
        append_event(&tx, &plan, kind, summary, now)?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 审查必须对应真实交付版本；返工次数单调递增，三轮未解决撤销新操作授权。
    pub fn save_workflow_finding(
        &mut self,
        id: &str,
        finding: &ReviewFinding,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
        if !identity_valid(&finding.finding_id)
            || finding.summary.trim().is_empty()
            || finding.summary.encode_utf16().count() > 8_000
            || finding.rework_rounds > 100
            || !revision_valid(&finding.revision)
            || !["open", "resolved", "needs_user"].contains(&finding.status.as_str())
            || !runs.iter().any(|run| {
                run.work_item_id == finding.work_item_id
                    && run.intent_version == plan.intent_version
                    && run.status == "completed"
                    && run.revision.as_deref() == Some(&finding.revision)
            })
            || !runs.iter().any(|run| {
                run.work_item_id != finding.work_item_id
                    && run.intent_version == plan.intent_version
                    && run.status == "completed"
                    && run.revision.as_deref() == Some(&finding.revision)
                    && plan.work_items.iter().any(|item| {
                        item.work_item_id == run.work_item_id
                            && item.role == semi_os_protocol::WorkRole::Review
                    })
            })
        {
            return Err(invalid("finding requires a current completed revision"));
        }
        let old: Option<String> = self.connection.query_row(
            "SELECT evidence_json FROM workflow_evidence WHERE workflow_id=?1 AND evidence_id=?2 AND kind='finding'",
            params![id,finding.finding_id], |row| row.get(0),
        ).optional()?;
        if let Some(old) = old {
            let old: ReviewFinding = serde_json::from_str(&old)?;
            if old.work_item_id != finding.work_item_id
                || finding.rework_rounds < old.rework_rounds
                || finding.rework_rounds > old.rework_rounds + 1
            {
                return Err(invalid("invalid rework progression"));
            }
        } else if finding.rework_rounds != 0 {
            return Err(invalid("new finding starts at round zero"));
        }
        let mut finding = finding.clone();
        if finding.status != "resolved" && finding.rework_rounds >= 3 {
            finding.status = "needs_user".into();
        }
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO workflow_evidence(workflow_id,evidence_id,kind,evidence_json) VALUES(?1,?2,'finding',?3)
            ON CONFLICT(workflow_id,evidence_id) DO UPDATE SET evidence_json=excluded.evidence_json",
            params![id,finding.finding_id,serde_json::to_string(&finding)?])?;
        if finding.status == "needs_user" {
            tx.execute(
                "UPDATE workflows SET status='paused' WHERE workflow_id=?1",
                [id],
            )?;
        }
        append_event(&tx, &plan, "review.finding", &finding.summary, now)?;
        save_evidence_history(&tx, id, "finding", &serde_json::to_string(&finding)?, now)?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    pub fn save_integration_result(
        &mut self,
        id: &str,
        result: &IntegrationResult,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
        let integration = runs
            .iter()
            .find(|run| {
                run.intent_version == plan.intent_version
                    && run.revision.as_deref() == Some(&result.revision)
                    && run.workspace.as_deref() == Some(&result.workspace)
                    && run.branch.as_deref() == Some(&result.branch)
                    && plan.work_items.iter().any(|item| {
                        item.work_item_id == run.work_item_id
                            && item.role == semi_os_protocol::WorkRole::Integration
                    })
            })
            .ok_or_else(|| invalid("integration requires an owned current revision"))?;
        if !revision_valid(&result.revision) || !["unverified","conflict","verified"].contains(&result.status.as_str()) || result.tests.len() > 100 || result.reviews.len() > 100 || result.commits.len() > 100
            || result.commits.iter().any(|commit| !runs.iter().any(|run| run.intent_version == plan.intent_version && run.status == "completed" && run.revision.as_ref() == Some(commit)))
            || result.tests.iter().any(|test| test.revision != result.revision || test.command.trim().is_empty()
                || !self.connection.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE artifact_id=?1 AND task_id=?2
                    AND kind='workflow_test' AND json_extract(metadata_json,'$.revision')=?3
                    AND json_extract(metadata_json,'$.command')=?4 AND json_extract(metadata_json,'$.exitCode')=?5)",
                    params![test.artifact_id,integration.run_id,result.revision,test.command,test.exit_code],|row| row.get::<_,bool>(0)).unwrap_or(false))
            || result.reviews.iter().any(|review| review.revision != result.revision || !runs.iter().any(|run|
                run.run_id == review.run_id && run.intent_version == plan.intent_version && run.run_id != integration.run_id
                && run.status == "completed" && run.revision.as_deref() == Some(&result.revision)
                && plan.work_items.iter().any(|item| item.work_item_id == run.work_item_id && item.role == semi_os_protocol::WorkRole::Review))
                || review.finding_ids.iter().any(|id| !snapshot["findings"].as_array().is_some_and(|findings| findings.iter().any(|f| f["findingId"] == *id && f["revision"] == result.revision)))) {
            return Err(invalid("invalid revision-bound integration evidence"));
        }
        if result.status == "verified"
            && (integration.status != "completed"
                || result.tests.is_empty()
                || result.tests.iter().any(|test| test.exit_code != 0)
                || result.reviews.is_empty()
                || snapshot["findings"]
                    .as_array()
                    .is_some_and(|findings| findings.iter().any(|f| f["status"] != "resolved")))
        {
            return Err(invalid("integration is not verified"));
        }
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO workflow_evidence(workflow_id,evidence_id,kind,evidence_json) VALUES(?1,'integration','integration',?2)
            ON CONFLICT(workflow_id,evidence_id) DO UPDATE SET evidence_json=excluded.evidence_json",
            params![id,serde_json::to_string(result)?])?;
        append_event(
            &tx,
            &plan,
            "integration.recorded",
            &format!("{} · {}", result.revision, result.status),
            now,
        )?;
        save_evidence_history(&tx, id, "integration", &serde_json::to_string(result)?, now)?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 测试输出只由受控执行服务上报；绑定拥有该提交的整合尝试，不能复用调研 Artifact。
    pub fn save_workflow_test(
        &mut self,
        id: &str,
        run_id: &str,
        evidence: &semi_os_protocol::TestEvidence,
        text: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let runs: Vec<AgentRun> = serde_json::from_value(snapshot["runs"].clone())?;
        let run = runs
            .iter()
            .find(|run| {
                run.run_id == run_id
                    && run.intent_version == plan.intent_version
                    && run.status == "completed"
                    && run.revision.as_deref() == Some(&evidence.revision)
                    && plan.work_items.iter().any(|item| {
                        item.work_item_id == run.work_item_id
                            && item.role == semi_os_protocol::WorkRole::Integration
                    })
            })
            .ok_or_else(|| invalid("test requires completed integration revision"))?;
        if !identity_valid(&evidence.artifact_id)
            || evidence.command.trim().is_empty()
            || evidence.command.len() > 8_000
            || text.len() > 128_000
        {
            return Err(invalid("invalid test artifact"));
        }
        self.authorize_work_item(
            id,
            plan.version,
            snapshot["digest"].as_str().unwrap_or(""),
            &run.work_item_id,
        )?;
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO artifacts(artifact_id,task_id,kind,uri,media_type,metadata_json,created_at_ms,content_text)
            VALUES(?1,?2,'workflow_test',?3,'text/plain',?4,?5,?6)",
            params![evidence.artifact_id,run_id,format!("artifact:{}",evidence.artifact_id),serde_json::to_string(evidence)?,now,text])?;
        append_event(
            &tx,
            &plan,
            "integration.test",
            &format!("{} · exit {}", evidence.command, evidence.exit_code),
            now,
        )?;
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    pub fn consume_workflow_events(&mut self, id: &str, sequence: i64) -> StorageResult<()> {
        let changed = self.connection.execute(
            "UPDATE workflows SET consumed_sequence=MAX(consumed_sequence,?2) WHERE workflow_id=?1 AND ?2<=last_sequence AND ?2>=0",
            params![id,sequence],
        )?;
        if changed != 1 {
            return Err(invalid("invalid event cursor"));
        }
        Ok(())
    }

    /// 重启没有进程回执，不能把上一次 running 当作仍运行，也不能自动重发需求。
    pub fn recover_workflow_runs(&mut self, now: i64) -> StorageResult<usize> {
        // 用户授权也不允许在重启后重放：可能已经移动源分支，只能手动核对。
        let ids: Vec<String> = {
            let mut statement = self.connection.prepare("SELECT DISTINCT workflow_id FROM workflow_applications WHERE status IN ('approved','executing')")?;
            let ids = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            ids
        };
        for id in ids {
            self.record_workflow_event(
                &id,
                "application.unknown",
                "重启中断成果应用，请手工核对源分支，旧批准不可重放",
                now,
            )?;
        }
        self.connection.execute("UPDATE workflow_applications SET status='unknown',updated_at_ms=?1 WHERE status IN ('approved','executing')",[now])?;
        let mut statement = self.connection.prepare(
            "SELECT run_json FROM agent_runs WHERE json_extract(run_json,'$.status') IN ('queued','running')",
        )?;
        let raw = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut recovered = 0;
        for raw in &raw {
            let mut run: AgentRun = serde_json::from_str(raw)?;
            if run.status == "queued"
                && self.workflow_run_phase(&run.run_id)?.as_deref() == Some("not_started")
            {
                continue;
            }
            run.status = "unknown".into();
            run.error = Some("Worker 已重启，先核对 Provider 会话与工作区，不自动重试".into());
            self.save_agent_run(&run, now)?;
            recovered += 1;
        }
        // Worker 消失时，持有领取的模型轮次也可能已经派单。保留游标，不重放。
        self.connection.execute("UPDATE workflow_coordinators SET owner=NULL,lease_until_ms=0,
            execution_status='needs_user',reason='Worker 中断协调，请核对已执行操作',last_activity_ms=?1
            WHERE owner IS NOT NULL", [now])?;
        Ok(recovered)
    }

    /// 仅由 Host 的用户命令调用。批准必须匹配 UI 正在展示的版本和内容，不允许覆盖拒绝。
    pub fn decide_workflow(
        &mut self,
        id: &str,
        version: u32,
        digest: &str,
        decision: &str,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        self.decide_workflow_with_reason(id, version, digest, decision, None, now)
    }

    pub fn decide_workflow_with_reason(
        &mut self,
        id: &str,
        version: u32,
        digest: &str,
        decision: &str,
        reason: Option<&str>,
        now: i64,
    ) -> StorageResult<WorkflowSnapshotDto> {
        if !["approved", "rejected", "needs_revision"].contains(&decision) {
            return Err(invalid("invalid user decision"));
        }
        if reason.is_some_and(|text| text.trim().is_empty() || text.len() > 32_000) {
            return Err(invalid("invalid user revision request"));
        }
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if snapshot["plan"]["version"] != version
            || snapshot["digest"] != digest
            || snapshot["status"] != "awaiting_approval"
        {
            return Err(invalid("stale plan or decision already recorded"));
        }
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO workflow_decisions(workflow_id,plan_version,decision,decided_at_ms) VALUES(?1,?2,?3,?4)",
            params![id,version,decision,now],
        )?;
        tx.execute(
            "UPDATE workflows SET status=?2 WHERE workflow_id=?1",
            params![id, decision],
        )?;
        if decision == "approved" {
            tx.execute("INSERT INTO workflow_grants(workflow_id,intent_version,plan_version,digest,repository,actions_json,approved_at_ms)
                VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(workflow_id) DO UPDATE SET
                intent_version=excluded.intent_version,plan_version=excluded.plan_version,digest=excluded.digest,
                repository=excluded.repository,actions_json=excluded.actions_json,approved_at_ms=excluded.approved_at_ms",
                params![id,plan.intent_version,version,digest,plan.repository,serde_json::to_string(&plan.authorized_actions)?,now])?;
            tx.execute("UPDATE workflow_coordinators SET execution_status='running',reason=NULL,no_progress=0 WHERE workflow_id=?1 AND owner IS NULL",[id])?;
        }
        append_event(&tx, &plan, "plan.decided", decision, now)?;
        if let Some(reason) = reason {
            append_event(&tx, &plan, "user.revision_requested", reason, now)?;
        }
        tx.commit()?;
        self.load_workflow_dto(id)?
            .ok_or_else(|| invalid("missing workflow"))
    }

    /// 每次实施启动都向 Host 核对当前批准；不能把 Worker 缓存的 approved 当作长期授权。
    pub fn authorize_work_item(
        &self,
        id: &str,
        version: u32,
        digest: &str,
        work_item: &str,
    ) -> StorageResult<WorkflowPlan> {
        self.guard_application(id)?;
        let snapshot = self
            .load_workflow(id)?
            .ok_or_else(|| invalid("unknown workflow"))?;
        if snapshot["plan"]["version"] != version || snapshot["digest"] != digest {
            return Err(invalid("stale plan approval"));
        }
        let plan: WorkflowPlan = serde_json::from_value(snapshot["plan"].clone())?;
        let item = plan
            .work_items
            .iter()
            .find(|item| item.work_item_id == work_item)
            .ok_or_else(|| invalid("unknown work item"))?;
        if [
            "paused",
            "cancelled",
            "rejected",
            "needs_revision",
            "unknown",
        ]
        .contains(&snapshot["status"].as_str().unwrap_or(""))
        {
            return Err(invalid("workflow cannot start new operations"));
        }
        if item.role.is_writing() && snapshot["status"] != "approved" {
            return Err(invalid("implementation requires current user approval"));
        }
        if snapshot["background"]["coordinator"]["executionStatus"] == "needs_user" {
            return Err(invalid("background execution requires reconciliation"));
        }
        Ok(plan)
    }
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
