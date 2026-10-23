use super::*;
use crate::{WorkflowCheckpoint, WorkflowClaimResult, WorkflowDecisionActor};
fn claimed_sequence(result: &WorkflowClaimResult) -> i64 {
    match result {
        WorkflowClaimResult::Claimed { sequence, .. } => *sequence,
        WorkflowClaimResult::Unclaimed { .. } => panic!("expected a claimed workflow"),
    }
}
fn plan() -> WorkflowPlan {
    serde_json::from_str(include_str!(
        "../../../tests/contract/fixtures/workflow-plan.json"
    ))
    .unwrap()
}
fn approved() -> (Storage, WorkflowPlan, String) {
    let mut db = Storage::open_in_memory().unwrap();
    let plan = plan();
    let (plan, digest) = approve_plan(&mut db, plan);
    (db, plan, digest)
}

fn approve_plan(db: &mut Storage, plan: WorkflowPlan) -> (WorkflowPlan, String) {
    let digest = format!("sha256:{}", "a".repeat(64));
    db.create_client_session(&plan.session_id, "fixture", 1)
        .unwrap();
    db.save_workflow_plan(&plan, &digest, 1).unwrap();
    db.decide_workflow(&plan.workflow_id, 1, &digest, "approved", 2)
        .unwrap();
    (plan, digest)
}

#[test]
fn custom_no_progress_budget_is_used_by_background_coordinator() {
    let mut plan = plan();
    plan.execution_budget.max_no_progress_turns = 1;
    let mut db = Storage::open_in_memory().unwrap();
    approve_plan(&mut db, plan.clone());
    let id = &plan.workflow_id;
    let claim = db.claim_workflow(id, "owner", 3).unwrap();
    let cp = WorkflowCheckpoint {
        session_id: format!("coordinator_{id}"),
        sequence: 1,
        data: Default::default(),
    };
    db.finish_workflow_claim(id, "owner", claimed_sequence(&claim), &cp, false, 4)
        .unwrap();
    assert_eq!(
        db.load_workflow(id).unwrap().unwrap()["background"]["coordinator"]["executionStatus"],
        "needs_user"
    );
}

#[test]
fn legacy_checkpoint_without_fingerprint_uses_durable_events_as_progress() {
    let (mut db, plan, _) = approved();
    let id = &plan.workflow_id;
    let claim = db.claim_workflow(id, "owner", 3).unwrap();
    db.record_workflow_event(id, "run.completed", "旧检查点兼容进展", 4)
        .unwrap();
    let cp = WorkflowCheckpoint {
        session_id: format!("coordinator_{id}"),
        sequence: 1,
        data: Default::default(),
    };
    db.finish_workflow_claim(id, "owner", claimed_sequence(&claim), &cp, true, 5)
        .unwrap();
    assert_eq!(
        db.load_workflow(id).unwrap().unwrap()["background"]["coordinator"]["noProgress"],
        0
    );
}
#[test]
fn background_claim_is_single_owner_idempotent_and_stale_lease_needs_reconciliation() {
    let (mut db, plan, _) = approved();
    let id = &plan.workflow_id;
    let claim = db.claim_workflow(id, "owner", 3).unwrap();
    assert!(matches!(claim, WorkflowClaimResult::Claimed { .. }));
    assert!(matches!(
        db.claim_workflow(id, "other", 4).unwrap(),
        WorkflowClaimResult::Unclaimed { needs_user: false }
    ));
    assert_eq!(
        claimed_sequence(&db.claim_workflow(id, "owner", 5).unwrap()),
        claimed_sequence(&claim)
    );
    assert!(matches!(
        db.claim_workflow(id, "other", 100_000).unwrap(),
        WorkflowClaimResult::Unclaimed { needs_user: true }
    ));
    assert_eq!(
        db.load_workflow(id).unwrap().unwrap()["background"]["coordinator"]["executionStatus"],
        "needs_user"
    );
    db.resume_workflow_coordinator(id, 100_001).unwrap();
    // 恢复丢失回执的批次不会重放；用户恢复事件才唤醒下一轮。
    let next = db.claim_workflow(id, "new", 100_002).unwrap();
    assert!(claimed_sequence(&next) > claimed_sequence(&claim));
    let cp = WorkflowCheckpoint {
        session_id: format!("coordinator_{id}"),
        sequence: 1,
        data: Default::default(),
    };
    db.finish_workflow_claim(id, "new", claimed_sequence(&next), &cp, false, 100_003)
        .unwrap();
    db.finish_workflow_claim(id, "new", claimed_sequence(&next), &cp, false, 100_004)
        .unwrap();
    assert!(matches!(
        db.claim_workflow(id, "empty", 100_005).unwrap(),
        WorkflowClaimResult::Unclaimed { needs_user: false }
    ));
}

#[test]
fn changing_user_intent_revokes_grant_before_any_worker_notification() {
    let (mut db, plan, digest) = approved();
    assert!(db.workflow_grant(&plan.workflow_id).unwrap().is_some());
    let result = db
        .change_workflow_intent(&plan.workflow_id, "不要修改，改为只读评估", 3)
        .unwrap();
    assert_eq!(result.status, "needs_revision");
    assert!(db.workflow_grant(&plan.workflow_id).unwrap().is_none());
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "implement")
        .is_err());
    assert!(matches!(
        db.claim_workflow(&plan.workflow_id, "owner", 4).unwrap(),
        WorkflowClaimResult::Unclaimed { needs_user: false }
    ));
}

#[test]
fn three_turns_without_durable_progress_require_user_and_are_searchable() {
    let (mut db, plan, _) = approved();
    let id = &plan.workflow_id;
    let mut now = 3;
    for round in 1..=3 {
        let claim = db.claim_workflow(id, "owner", now).unwrap();
        assert!(matches!(claim, WorkflowClaimResult::Claimed { .. }));
        now += 1;
        let cp = WorkflowCheckpoint {
            session_id: format!("coordinator_{id}"),
            sequence: round,
            data: Default::default(),
        };
        // Worker 声称有进展也不能覆盖没有实际事件的事实。
        db.finish_workflow_claim(id, "owner", claimed_sequence(&claim), &cp, true, now)
            .unwrap();
        now += 1;
        if round < 3 {
            db.record_workflow_event(id, "run.health", "仍无活动", now)
                .unwrap();
            now += 1;
        }
    }
    let snapshot = db.load_workflow(id).unwrap().unwrap();
    assert_eq!(snapshot["status"], "approved");
    assert_eq!(
        snapshot["background"]["coordinator"]["executionStatus"],
        "needs_user"
    );
    assert_eq!(snapshot["background"]["coordinator"]["noProgress"], 3);
    assert!(matches!(
        db.claim_workflow(id, "owner", now).unwrap(),
        WorkflowClaimResult::Unclaimed { needs_user: false }
    ));
    assert_eq!(db.find_workflows("", "", "needs_user").unwrap().len(), 1);
    assert_eq!(
        db.find_workflows(&plan.title, &plan.repository, "approved")
            .unwrap()
            .len(),
        1
    );
    assert!(db
        .find_workflows("missing", "", "needs_user")
        .unwrap()
        .is_empty());
}

#[test]
fn delegated_questions_keep_human_and_agent_answers_distinct_and_idempotent() {
    let (mut db, plan, _) = approved();
    let work = &plan.work_items[0];
    let mut run = AgentRun {
        run_id: "run_question".into(),
        workflow_id: plan.workflow_id.clone(),
        work_item_id: work.work_item_id.clone(),
        plan_version: 1,
        intent_version: 1,
        attempt: 1,
        provider: work.provider.clone(),
        status: "queued".into(),
        started_at_ms: 3,
        ended_at_ms: None,
        workspace: None,
        provider_session_id: None,
        revision: None,
        summary: None,
        error: None,
        branch: None,
        baseline_commit: None,
        permission: None,
        capabilities: None,
    };
    db.save_agent_run(&run, 3).unwrap();
    run.status = "running".into();
    run.workspace = Some("/tmp/run_question".into());
    run.branch = Some("codex/run_question".into());
    run.baseline_commit = Some("a".repeat(40));
    db.save_agent_run(&run, 4).unwrap();
    db.claim_workflow(&plan.workflow_id, "owner", 5).unwrap();
    let input = serde_json::from_value(json!({"questions":[{"question":"用户偏好？"}]})).unwrap();
    db.register_workflow_decision(
        &plan.workflow_id,
        &run.run_id,
        "question",
        "clarification",
        &input,
        6,
    )
    .unwrap();
    let delegated =
        serde_json::from_value(json!({"authority":"needs_user","reason":"用户偏好不能猜测"}))
            .unwrap();
    db.save_delegate_decision(
        &plan.workflow_id,
        &run.run_id,
        "question",
        "clarification",
        &delegated,
        7,
    )
    .unwrap();
    db.save_delegate_decision(
        &plan.workflow_id,
        &run.run_id,
        "question",
        "clarification",
        &delegated,
        8,
    )
    .unwrap();
    assert!(db
        .resume_workflow_coordinator(&plan.workflow_id, 9)
        .is_err());
    assert!(db
        .answer_workflow_decision(
            &plan.workflow_id,
            "question",
            &serde_json::from_value(json!({"answers":{"不同问题":"x"}})).unwrap(),
            10
        )
        .is_err());
    let answer = serde_json::from_value(json!({"answers":{"用户偏好？":"极简风格"}})).unwrap();
    db.answer_workflow_decision(&plan.workflow_id, "question", &answer, 11)
        .unwrap();
    let count = db.load_workflow(&plan.workflow_id).unwrap().unwrap()["events"]
        .as_array()
        .unwrap()
        .len();
    db.answer_workflow_decision(&plan.workflow_id, "question", &answer, 12)
        .unwrap();
    assert_eq!(
        db.load_workflow(&plan.workflow_id).unwrap().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        count
    );
    assert_eq!(
        db.workflow_decision_result(&plan.workflow_id, "question")
            .unwrap()
            .unwrap()
            .actor,
        WorkflowDecisionActor::User
    );
    assert!(db
        .answer_workflow_decision(
            &plan.workflow_id,
            "question",
            &serde_json::from_value(json!({"answers":{"用户偏好？":"其他"}})).unwrap(),
            13
        )
        .is_err());
}
fn deliver(db: &mut Storage, plan: &WorkflowPlan, item: usize, revision: &str) -> AgentRun {
    let work = &plan.work_items[item];
    let mut run = AgentRun {
        run_id: format!("run_{}", work.work_item_id),
        workflow_id: plan.workflow_id.clone(),
        work_item_id: work.work_item_id.clone(),
        plan_version: plan.version,
        intent_version: plan.intent_version,
        attempt: 1,
        provider: work.provider.clone(),
        status: "queued".into(),
        started_at_ms: 3,
        ended_at_ms: None,
        workspace: None,
        provider_session_id: None,
        revision: None,
        summary: None,
        error: None,
        branch: None,
        baseline_commit: None,
        permission: None,
        capabilities: None,
    };
    db.save_agent_run(&run, 3).unwrap();
    run.status = "running".into();
    run.workspace = Some(format!("/tmp/{}", run.run_id));
    run.branch = Some(format!("codex/{}", run.run_id));
    run.baseline_commit = Some(revision.into());
    db.save_agent_run(&run, 4).unwrap();
    run.status = "completed".into();
    run.revision = Some(revision.into());
    run.ended_at_ms = Some(5);
    db.save_agent_run(&run, 5).unwrap();
    run
}
#[test]
fn refinement_preserves_boundary_and_deliveries_but_material_changes_revoke_approval() {
    let (mut db, mut plan, digest) = approved();
    deliver(&mut db, &plan, 0, &"a".repeat(40));
    plan.version = 2;
    plan.work_items[1].provider = semi_os_protocol::CodingProvider::Codex;
    db.refine_workflow_plan(&plan, &digest, 6).unwrap();
    db.authorize_work_item(&plan.workflow_id, 2, &digest, "implement")
        .unwrap();
    let mut changed = plan.clone();
    changed.version = 3;
    changed.goal = "different".into();
    assert!(db.refine_workflow_plan(&changed, &digest, 7).is_err());
    changed.intent_version = 2;
    db.save_workflow_plan(&changed, &digest, 8).unwrap();
    assert!(db
        .authorize_work_item(&changed.workflow_id, 3, &digest, "implement")
        .is_err());
    assert!(db
        .authorize_work_item(&changed.workflow_id, 2, &digest, "implement")
        .is_err());
}
#[test]
fn recovery_is_unknown_and_terminal_runs_are_immutable() {
    let (mut db, plan, _) = approved();
    let done = deliver(&mut db, &plan, 0, &"a".repeat(40));
    assert!(db.save_agent_run(&done, 6).is_err());
    let mut run = done;
    run.run_id = "run_queued".into();
    run.attempt = 2;
    run.status = "queued".into();
    run.ended_at_ms = None;
    run.revision = None;
    db.save_agent_run(&run, 7).unwrap();
    assert_eq!(db.recover_workflow_runs(8).unwrap(), 0);
    assert_eq!(
        db.load_workflow(&plan.workflow_id).unwrap().unwrap()["runs"][1]["status"],
        "queued"
    );
    db.mark_workflow_run_phase(&run.run_id, "start_requested", 8)
        .unwrap();
    assert_eq!(db.recover_workflow_runs(8).unwrap(), 1);
    let snapshot = db.load_workflow(&plan.workflow_id).unwrap().unwrap();
    assert_eq!(snapshot["runs"][1]["status"], "unknown");
    assert!(db.save_agent_run(&run, 9).is_err());
    run.status = "cancelled".into();
    db.save_agent_run(&run, 10).unwrap();
}
#[test]
fn independent_review_and_three_reworks_are_persisted_without_self_attestation() {
    let (mut db, mut plan, digest) = approved();
    let revision = "a".repeat(40);
    deliver(&mut db, &plan, 0, &revision);
    deliver(&mut db, &plan, 1, &revision);
    let mut finding = ReviewFinding {
        finding_id: "finding".into(),
        work_item_id: "implement".into(),
        revision: revision.clone(),
        summary: "missing test".into(),
        status: "open".into(),
        rework_rounds: 0,
    };
    assert!(db
        .save_workflow_finding(&plan.workflow_id, &finding, 6)
        .is_err());
    let mut review = plan.work_items[0].clone();
    review.work_item_id = "review".into();
    review.role = semi_os_protocol::WorkRole::Review;
    review.dependencies = vec!["implement".into()];
    review.capabilities = Some(vec![
        semi_os_protocol::Capability::ReadRepo,
        semi_os_protocol::Capability::ReadFiles,
        semi_os_protocol::Capability::ReadEvidence,
    ]);
    review.evidence = Some(semi_os_protocol::EvidenceRequirement {
        revision: true,
        tests: false,
        independent_review: true,
    });
    plan.work_items.push(review);
    plan.version = 2;
    db.refine_workflow_plan(&plan, &digest, 7).unwrap();
    deliver(&mut db, &plan, 2, &revision);
    for round in 0..=3 {
        finding.rework_rounds = round;
        db.save_workflow_finding(&plan.workflow_id, &finding, 8 + i64::from(round))
            .unwrap();
    }
    let snapshot = db.load_workflow(&plan.workflow_id).unwrap().unwrap();
    assert_eq!(snapshot["status"], "paused");
    assert_eq!(snapshot["findings"][0]["status"], "needs_user");
    let count: i64 = db
        .connection
        .query_row(
            "SELECT COUNT(*) FROM workflow_evidence_history WHERE kind='finding'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 4);
    assert!(db
        .authorize_work_item(&plan.workflow_id, 2, &digest, "implement")
        .is_err());
    db.control_workflow(&plan.workflow_id, "resume", 12)
        .unwrap();
    assert!(db
        .authorize_work_item(&plan.workflow_id, 2, &digest, "implement")
        .is_ok());
}
#[test]
fn approval_is_exact_version_and_old_approval_cannot_be_reused() {
    let mut db = Storage::open_in_memory().unwrap();
    let mut plan = plan();
    db.create_client_session(&plan.session_id, "test", 1)
        .unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    db.save_workflow_plan(&plan, &digest, 1).unwrap();
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "implement")
        .is_err());
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "plan")
        .is_ok());
    assert!(db
        .decide_workflow(&plan.workflow_id, 1, "wrong", "approved", 2)
        .is_err());
    db.decide_workflow(&plan.workflow_id, 1, &digest, "approved", 2)
        .unwrap();
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "implement")
        .is_ok());
    assert!(db
        .decide_workflow(&plan.workflow_id, 1, &digest, "approved", 3)
        .is_err());
    plan.version = 2;
    plan.intent_version = 2;
    db.save_workflow_plan(&plan, &digest, 4).unwrap();
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "implement")
        .is_err());
    assert!(db
        .authorize_work_item(&plan.workflow_id, 2, &digest, "implement")
        .is_err());
    assert_eq!(
        db.load_workflow(&plan.workflow_id).unwrap().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}
#[test]
fn rejected_plan_cannot_start_even_read_only_work() {
    let mut db = Storage::open_in_memory().unwrap();
    let plan = plan();
    db.create_client_session(&plan.session_id, "test", 1)
        .unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    db.save_workflow_plan(&plan, &digest, 1).unwrap();
    db.decide_workflow(&plan.workflow_id, 1, &digest, "rejected", 2)
        .unwrap();
    assert!(db
        .authorize_work_item(&plan.workflow_id, 1, &digest, "plan")
        .is_err());
}

#[test]
fn live_workflows_prevent_session_deletion_without_losing_the_control_entrypoint() {
    let (mut db, plan, _) = approved();
    db.create_client_session("session_other", "other", 3)
        .unwrap();
    db.activate_client_session(&plan.session_id).unwrap();
    assert!(db.delete_client_session(&plan.session_id).is_err());
    assert!(db
        .activate_and_delete_client_session("session_other", Some(&plan.session_id))
        .is_err());
    assert!(db
        .load_client_sessions()
        .unwrap()
        .iter()
        .any(|session| session.session_id == plan.session_id && session.active));
    db.control_workflow(&plan.workflow_id, "cancel", 4).unwrap();
    db.activate_and_delete_client_session("session_other", Some(&plan.session_id))
        .unwrap();
    let sessions = db.load_client_sessions().unwrap();
    assert!(!sessions
        .iter()
        .any(|session| session.session_id == plan.session_id));
    assert!(sessions
        .iter()
        .any(|session| session.session_id == "session_other" && session.active));
    assert!(db.load_workflow(&plan.workflow_id).unwrap().is_some());
}

#[test]
fn activity_backlog_does_not_hide_terminal_notifications() {
    let (mut db, plan, _) = approved();
    for index in 0..150 {
        db.record_workflow_event(&plan.workflow_id, "run.activity", "tool", index + 3)
            .unwrap();
    }
    db.record_workflow_event(&plan.workflow_id, "run.completed", "done", 200)
        .unwrap();
    let notifications = db.workflow_notifications(&plan.session_id).unwrap();
    assert!(notifications
        .iter()
        .any(|n| n["event"]["kind"] == "run.completed"));
    let sequence = notifications.last().unwrap()["event"]["sequence"]
        .as_i64()
        .unwrap();
    db.consume_workflow_events(&plan.workflow_id, sequence)
        .unwrap();
    assert!(db
        .workflow_notifications(&plan.session_id)
        .unwrap()
        .is_empty());
}

#[test]
fn verified_integration_requires_real_artifact_and_independent_current_revision_review() {
    let (mut db, mut plan, digest) = approved();
    let revision = "a".repeat(40);
    deliver(&mut db, &plan, 0, &revision);
    deliver(&mut db, &plan, 1, &revision);
    let mut integrate = plan.work_items[1].clone();
    integrate.work_item_id = "integrate".into();
    integrate.role = semi_os_protocol::WorkRole::Integration;
    integrate.dependencies = vec!["implement".into()];
    let mut review = integrate.clone();
    review.work_item_id = "review".into();
    review.role = semi_os_protocol::WorkRole::Review;
    review.dependencies = vec!["integrate".into()];
    review.capabilities = Some(vec![
        semi_os_protocol::Capability::ReadRepo,
        semi_os_protocol::Capability::ReadFiles,
        semi_os_protocol::Capability::ReadEvidence,
    ]);
    review.evidence = Some(semi_os_protocol::EvidenceRequirement {
        revision: true,
        tests: false,
        independent_review: true,
    });
    plan.work_items.extend([integrate, review]);
    plan.version = 2;
    db.refine_workflow_plan(&plan, &digest, 6).unwrap();
    let integrated = deliver(&mut db, &plan, 2, &revision);
    let reviewed = deliver(&mut db, &plan, 3, &revision);
    let evidence = semi_os_protocol::TestEvidence {
        artifact_id: "artifact_test".into(),
        revision: revision.clone(),
        command: "node check.mjs".into(),
        exit_code: 0,
    };
    let mut result = IntegrationResult {
        revision: revision.clone(),
        branch: integrated.branch.clone().unwrap(),
        workspace: integrated.workspace.clone().unwrap(),
        commits: vec![revision.clone()],
        status: "verified".into(),
        tests: vec![evidence.clone()],
        reviews: vec![semi_os_protocol::ReviewEvidence {
            run_id: reviewed.run_id.clone(),
            revision: revision.clone(),
            finding_ids: vec![],
        }],
    };
    assert!(db
        .save_integration_result(&plan.workflow_id, &result, 7)
        .is_err());
    db.persist_task_event(
        crate::TaskSnapshot {
            task_id: integrated.run_id.clone(),
            task_run_id: "task_run_test".into(),
            trace_id: "trace_test".into(),
            lifecycle: semi_os_protocol::TaskLifecycle::Created,
            title: None,
            current_step: None,
            checkpoint: None,
            last_event_sequence: 0,
            created_at_ms: 7,
            updated_at_ms: 7,
        },
        crate::NewTaskEvent {
            event_id: "evt_test_created".into(),
            event_kind: "task.created".into(),
            payload: json!({}),
            occurred_at_ms: 7,
        },
    )
    .unwrap();
    db.save_workflow_test(
        &plan.workflow_id,
        &integrated.run_id,
        &evidence,
        "passed",
        8,
    )
    .unwrap();
    result.reviews[0].run_id = integrated.run_id.clone();
    assert!(db
        .save_integration_result(&plan.workflow_id, &result, 9)
        .is_err());
    result.reviews[0].run_id = reviewed.run_id;
    db.save_integration_result(&plan.workflow_id, &result, 10)
        .unwrap();
    let application = WorkflowApplication {
        application_id: "apply_fixture".into(),
        workflow_id: plan.workflow_id.clone(),
        version: plan.version,
        digest: digest.clone(),
        repository: plan.repository.clone(),
        workspace: result.workspace.clone(),
        expected_ref: "refs/heads/main".into(),
        expected_head: "c".repeat(40),
        revision: revision.clone(),
    };
    let mut stale = application.clone();
    stale.version = 1;
    assert!(db.approve_workflow_application(&stale, 10).is_err());
    assert!(db
        .begin_workflow_application(&application.application_id, 10)
        .is_err());
    db.approve_workflow_application(&application, 10).unwrap();
    assert!(db.approve_workflow_application(&application, 10).is_err());
    db.begin_workflow_application(&application.application_id, 10)
        .unwrap();
    assert!(db
        .begin_workflow_application(&application.application_id, 10)
        .is_err());
    db.finish_workflow_application(&application.application_id, true, 10)
        .unwrap();
    assert!(db
        .begin_workflow_application(&application.application_id, 10)
        .is_err());
    let mut interrupted = application.clone();
    interrupted.application_id = "apply_interrupted".into();
    db.approve_workflow_application(&interrupted, 10).unwrap();
    db.begin_workflow_application(&interrupted.application_id, 10)
        .unwrap();
    db.recover_workflow_runs(11).unwrap();
    assert!(db
        .begin_workflow_application(&interrupted.application_id, 11)
        .is_err());
    assert!(db.approve_workflow_application(&stale, 11).is_err());
    assert!(
        db.load_workflow(&plan.workflow_id).unwrap().unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "application.unknown")
    );
    db.control_workflow(&plan.workflow_id, "reconcile_application", 11)
        .unwrap();
    result.tests[0].revision = "b".repeat(40);
    assert!(db
        .save_integration_result(&plan.workflow_id, &result, 11)
        .is_err());
    plan.version = 3;
    plan.intent_version = 2;
    plan.goal = "new requirement".into();
    db.save_workflow_plan(&plan, &digest, 12).unwrap();
    let current = db.load_workflow(&plan.workflow_id).unwrap().unwrap();
    assert!(current["integration"].is_null());
    let history: i64 = db
        .connection
        .query_row(
            "SELECT COUNT(*) FROM workflow_evidence_history WHERE kind='integration'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history, 1);
}
