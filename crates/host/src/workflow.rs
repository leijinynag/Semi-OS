use semi_os_protocol::{
    validate_workflow_plan, AgentRun, IntegrationResult, ReviewFinding, TestEvidence, WorkflowPlan,
};
use semi_os_storage::{
    Storage, WorkflowCheckpoint, WorkflowClaimResult, WorkflowDecisionResult, WorkflowSnapshotDto,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// 工作流操作的 Host 边界 DTO。
///
/// Worker 仍发送旧的 `{ operation, value }` 形状，但 Host 不再通过
/// `Value["field"]` 猜测业务含义。每个 operation 都先解码为明确的
/// variant，Storage 内部才可以继续兼容历史 JSON migration。
#[derive(Debug)]
enum WorkflowOperation {
    Suspend(SuspendRequest),
    Find(FindRequest),
    List(SessionRequest),
    Notifications(SessionRequest),
    Consume(ConsumeRequest),
    Submit(WorkflowPlan),
    Refine(WorkflowPlan),
    ApplicationBegin(ApplicationRequest),
    ApplicationFinish(ApplicationFinishRequest),
    Authorize(AuthorizeRequest),
    Run(AgentRun),
    Event(EventRequest),
    Finding(FindingRequest),
    Integration(IntegrationRequest),
    Test(TestRequest),
    RunPhase(RunPhaseRequest),
    RunPhaseRead(RunPhaseReadRequest),
    CoordinatorClaim(CoordinatorIdentityRequest),
    CoordinatorRenew(CoordinatorIdentityRequest),
    CoordinatorFinish(CoordinatorFinishRequest),
    CoordinatorFail(CoordinatorIdentityRequest),
    CoordinatorUnavailable(CoordinatorIdentityRequest),
    DelegateRequest(DelegateRequest),
    DelegateDecision(DelegateDecisionRequest),
    DelegateResult(DelegateResultRequest),
    OperationAuthorize(crate::workflow_policy::WorkflowAuthorizationRequest),
}

impl WorkflowOperation {
    fn name(&self) -> &'static str {
        match self {
            Self::Suspend(_) => "suspend",
            Self::Find(_) => "find",
            Self::List(_) => "list",
            Self::Notifications(_) => "notifications",
            Self::Consume(_) => "consume",
            Self::Submit(_) => "submit",
            Self::Refine(_) => "refine",
            Self::ApplicationBegin(_) => "application.begin",
            Self::ApplicationFinish(_) => "application.finish",
            Self::Authorize(_) => "authorize",
            Self::Run(_) => "run",
            Self::Event(_) => "event",
            Self::Finding(_) => "finding",
            Self::Integration(_) => "integration",
            Self::Test(_) => "test",
            Self::RunPhase(_) => "run.phase",
            Self::RunPhaseRead(_) => "run.phase.read",
            Self::CoordinatorClaim(_) => "coordinator.claim",
            Self::CoordinatorRenew(_) => "coordinator.renew",
            Self::CoordinatorFinish(_) => "coordinator.finish",
            Self::CoordinatorFail(_) => "coordinator.fail",
            Self::CoordinatorUnavailable(_) => "coordinator.unavailable",
            Self::DelegateRequest(_) => "delegate.request",
            Self::DelegateDecision(_) => "delegate.decision",
            Self::DelegateResult(_) => "delegate.result",
            Self::OperationAuthorize(_) => "operation.authorize",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowOperationEnvelope {
    operation_id: String,
    operation: String,
    value: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuspendRequest {
    workflow_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionRequest {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FindRequest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    repository: String,
    #[serde(default)]
    status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumeRequest {
    workflow_id: String,
    sequence: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplicationRequest {
    application_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplicationFinishRequest {
    application_id: String,
    applied: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizeRequest {
    workflow_id: String,
    version: u32,
    digest: String,
    work_item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventRequest {
    workflow_id: String,
    kind: String,
    summary: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FindingRequest {
    workflow_id: String,
    finding: ReviewFinding,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntegrationRequest {
    workflow_id: String,
    result: IntegrationResult,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestRequest {
    workflow_id: String,
    run_id: String,
    evidence: TestEvidence,
    text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunPhaseRequest {
    run_id: String,
    phase: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunPhaseReadRequest {
    run_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoordinatorIdentityRequest {
    workflow_id: String,
    owner: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoordinatorFinishRequest {
    workflow_id: String,
    owner: String,
    sequence: i64,
    checkpoint: WorkflowCheckpoint,
    progress: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateRequest {
    workflow_id: String,
    run_id: String,
    request_id: String,
    kind: String,
    input: semi_os_storage::WorkflowDecisionInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateDecisionRequest {
    workflow_id: String,
    run_id: String,
    request_id: String,
    kind: String,
    decision: semi_os_storage::WorkflowDecisionValue,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateResultRequest {
    workflow_id: String,
    request_id: String,
}

fn decode_operation_value(operation: &str, value: Value) -> Result<WorkflowOperation, String> {
    macro_rules! decode {
        ($ty:ty, $variant:ident) => {
            serde_json::from_value::<$ty>(value)
                .map(WorkflowOperation::$variant)
                .map_err(|error| format!("invalid {operation} payload: {error}"))
        };
    }
    match operation {
        "suspend" => decode!(SuspendRequest, Suspend),
        "find" => decode!(FindRequest, Find),
        "list" => decode!(SessionRequest, List),
        "notifications" => decode!(SessionRequest, Notifications),
        "consume" => decode!(ConsumeRequest, Consume),
        "submit" => decode!(WorkflowPlan, Submit),
        "refine" => decode!(WorkflowPlan, Refine),
        "application.begin" => decode!(ApplicationRequest, ApplicationBegin),
        "application.finish" => decode!(ApplicationFinishRequest, ApplicationFinish),
        "authorize" => decode!(AuthorizeRequest, Authorize),
        "run" => decode!(AgentRun, Run),
        "event" => decode!(EventRequest, Event),
        "finding" => decode!(FindingRequest, Finding),
        "integration" => decode!(IntegrationRequest, Integration),
        "test" => decode!(TestRequest, Test),
        "run.phase" => decode!(RunPhaseRequest, RunPhase),
        "run.phase.read" => decode!(RunPhaseReadRequest, RunPhaseRead),
        "coordinator.claim" => decode!(CoordinatorIdentityRequest, CoordinatorClaim),
        "coordinator.renew" => decode!(CoordinatorIdentityRequest, CoordinatorRenew),
        "coordinator.finish" => decode!(CoordinatorFinishRequest, CoordinatorFinish),
        "coordinator.fail" => decode!(CoordinatorIdentityRequest, CoordinatorFail),
        "coordinator.unavailable" => decode!(CoordinatorIdentityRequest, CoordinatorUnavailable),
        "delegate.request" => decode!(DelegateRequest, DelegateRequest),
        "delegate.decision" => decode!(DelegateDecisionRequest, DelegateDecision),
        "delegate.result" => decode!(DelegateResultRequest, DelegateResult),
        "operation.authorize" => serde_json::from_value(value)
            .map(WorkflowOperation::OperationAuthorize)
            .map_err(|error| format!("invalid operation.authorize payload: {error}")),
        _ => Err(format!("unsupported workflow operation: {operation}")),
    }
}

fn decode_operation_payload(payload: &Value) -> Result<WorkflowOperation, String> {
    let envelope: WorkflowOperationEnvelope = serde_json::from_value(payload.clone())
        .map_err(|error| format!("invalid workflow operation envelope: {error}"))?;
    if envelope.operation_id.trim().is_empty() {
        return Err("missing operationId".into());
    }
    decode_operation_value(&envelope.operation, envelope.value)
}

/// 真实产品与合成仓库共用同一个 RPC 入口；租约/授权永远重新核对当前状态。
/// 领取本身通过 owner 和持久事件游标幂等，不能从历史回执恢复已失效的租约。
pub fn dispatch_request(
    storage: &mut Storage,
    message: &semi_os_protocol::Envelope,
    now: i64,
) -> crate::HostResult<crate::rpc::RpcDispatchResult> {
    semi_os_protocol::validate_envelope(message)
        .map_err(|error| crate::HostError::InvalidRequest(error.message))?;
    let semi_os_protocol::Envelope::Event { kind, payload, .. } = message else {
        return Err(crate::HostError::InvalidRequest(
            "expected workflow event".into(),
        ));
    };
    if kind != "workflow.request" {
        return Err(crate::HostError::InvalidRequest(
            "expected workflow request".into(),
        ));
    }
    let operation = decode_operation_payload(payload).map_err(crate::HostError::InvalidRequest)?;
    let operation_name = operation.name();
    if [
        "authorize",
        "operation.authorize",
        "find",
        "list",
        "notifications",
        "run.phase.read",
        "delegate.result",
        "coordinator.claim",
        "coordinator.renew",
    ]
    .contains(&operation_name)
    {
        let result = match dispatch_typed_operation(storage, operation, now) {
            Ok(value) => semi_os_storage::RpcResult {
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(error) => semi_os_storage::RpcResult {
                ok: false,
                value: None,
                error: Some(error.ui_message().into()),
            },
        };
        Ok(crate::rpc::RpcDispatchResult {
            result,
            replayed: false,
        })
    } else {
        crate::rpc::dispatch(storage, message, now, |storage| {
            dispatch_typed_operation(storage, operation, now)
        })
    }
}

/// 快照类回执必须在发送成功 ACK 前解码，不能先报成功再发现 UI 契约损坏。
///
/// 旧 Worker 保留 JSON 形状；协调领取和决策结果也在这里解码，授权、游标等
/// 其他响应由各自边界校验。此处不重试写入，也不把落盘后无法读取的结果当作成功。
pub fn validate_operation_result(operation: &str, value: Value) -> crate::HostResult<Value> {
    if [
        "submit",
        "suspend",
        "refine",
        "run",
        "event",
        "finding",
        "integration",
        "test",
        "application.finish",
        "coordinator.finish",
        "coordinator.fail",
        "coordinator.unavailable",
        "delegate.decision",
        "delegate.request",
    ]
    .contains(&operation)
    {
        serde_json::from_value::<WorkflowSnapshotDto>(value.clone())?;
    } else if operation == "coordinator.claim" {
        serde_json::from_value::<WorkflowClaimResult>(value.clone())?;
    } else if operation == "delegate.result" {
        serde_json::from_value::<Option<WorkflowDecisionResult>>(value.clone())?;
    }
    Ok(value)
}

/// 路由只返回已校验的领域效果，Tauri 负责实际广播和 Worker 通知。
/// 重放回执不得重新发布历史快照，也不能再次唤醒后台协调器。
pub struct WorkflowEffects {
    pub snapshot: Option<WorkflowSnapshotDto>,
    pub notification: Option<&'static str>,
}

pub fn operation_effects(
    payload: &Value,
    outcome: &crate::rpc::RpcDispatchResult,
) -> crate::HostResult<WorkflowEffects> {
    let empty = || WorkflowEffects {
        snapshot: None,
        notification: None,
    };
    if outcome.replayed || !outcome.result.ok {
        return Ok(empty());
    }
    let operation = decode_operation_payload(payload).map_err(crate::HostError::InvalidRequest)?;
    let value = outcome.result.value.clone().unwrap_or(Value::Null);
    let observe = match &operation {
        WorkflowOperation::Run(run) => {
            ["completed", "failed", "blocked", "unknown"].contains(&run.status.as_str())
        }
        WorkflowOperation::Event(event) => event.kind == "run.health",
        WorkflowOperation::ApplicationFinish(_) | WorkflowOperation::DelegateRequest(_) => true,
        _ => false,
    };
    let snapshot = match operation {
        WorkflowOperation::Submit(_)
        | WorkflowOperation::Suspend(_)
        | WorkflowOperation::Refine(_)
        | WorkflowOperation::Run(_)
        | WorkflowOperation::Event(_)
        | WorkflowOperation::Finding(_)
        | WorkflowOperation::Integration(_)
        | WorkflowOperation::Test(_)
        | WorkflowOperation::ApplicationFinish(_)
        | WorkflowOperation::CoordinatorFinish(_)
        | WorkflowOperation::CoordinatorFail(_)
        | WorkflowOperation::CoordinatorUnavailable(_)
        | WorkflowOperation::DelegateDecision(_)
        | WorkflowOperation::DelegateRequest(_) => serde_json::from_value(value)?,
        WorkflowOperation::CoordinatorClaim(_) => {
            return Ok(
                match serde_json::from_value::<WorkflowClaimResult>(value)? {
                    WorkflowClaimResult::Claimed { snapshot, .. } => WorkflowEffects {
                        snapshot: Some(*snapshot),
                        notification: None,
                    },
                    WorkflowClaimResult::Unclaimed { .. } => empty(),
                },
            );
        }
        WorkflowOperation::Find(_)
        | WorkflowOperation::List(_)
        | WorkflowOperation::Notifications(_)
        | WorkflowOperation::Consume(_)
        | WorkflowOperation::ApplicationBegin(_)
        | WorkflowOperation::Authorize(_)
        | WorkflowOperation::RunPhase(_)
        | WorkflowOperation::RunPhaseRead(_)
        | WorkflowOperation::CoordinatorRenew(_)
        | WorkflowOperation::DelegateResult(_)
        | WorkflowOperation::OperationAuthorize(_) => return Ok(empty()),
    };
    let snapshot: WorkflowSnapshotDto = snapshot;
    let notification = if snapshot.status == "paused" {
        Some("pause")
    } else if observe {
        Some("observe")
    } else {
        None
    };
    Ok(WorkflowEffects {
        snapshot: Some(snapshot),
        notification,
    })
}

/// 原生壳和真实 Host 测试桥共用后台协议，不能由两处路由产生不同授权逻辑。
pub fn background_operation(
    storage: &mut Storage,
    operation: &str,
    value: &Value,
    now: i64,
) -> Option<Result<Value, String>> {
    // 兼容旧分派链：不属于后台入口的操作交给后续路由，不在这里解码或拒绝。
    if !operation.starts_with("coordinator.")
        && ![
            "suspend",
            "find",
            "run.phase",
            "run.phase.read",
            "delegate.request",
            "delegate.decision",
            "delegate.result",
            "operation.authorize",
        ]
        .contains(&operation)
    {
        return None;
    }
    let typed = match decode_operation_value(operation, value.clone()) {
        Ok(typed) => typed,
        Err(error) => return Some(Err(error)),
    };
    Some(dispatch_typed_operation_inner(storage, typed, now))
}

/// 摘要由 Host 对规范化类型计算；模型传来的 approved、digest、status 均无权生效。
pub fn submit(storage: &mut Storage, value: Value, now: i64) -> Result<Value, String> {
    store_plan(storage, value, now, false)
}
pub fn refine(storage: &mut Storage, value: Value, now: i64) -> Result<Value, String> {
    store_plan(storage, value, now, true)
}
fn store_plan(
    storage: &mut Storage,
    value: Value,
    now: i64,
    refinement: bool,
) -> Result<Value, String> {
    let plan: WorkflowPlan = serde_json::from_value(value).map_err(|_| "invalid workflow plan")?;
    store_typed_plan(storage, &plan, now, refinement)
}

// JSON 仅停留在兼容入口；已解码的计划直接验证与落盘，避免重复编解码。
fn store_typed_plan(
    storage: &mut Storage,
    plan: &WorkflowPlan,
    now: i64,
    refinement: bool,
) -> Result<Value, String> {
    validate_workflow_plan(plan)?;
    let bytes = serde_json::to_vec(plan).map_err(|_| "cannot encode plan")?;
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    (if refinement {
        storage.refine_workflow_plan(plan, &digest, now)
    } else {
        storage.save_workflow_plan(plan, &digest, now)
    })
    .map_err(|e| e.to_string())?;
    storage
        .load_workflow_dto(&plan.workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "missing plan".to_string())
        .and_then(|snapshot| {
            serde_json::to_value(snapshot).map_err(|_| "cannot encode workflow snapshot".into())
        })
}

/// 原生工具不能绕过已存在的协作批准。批准前仅允许读取；
/// 批准后仍由隔离执行服务管理目标仓库写入，不在用户源目录直接实施。
pub fn guard_native_operation(storage: &Storage, value: &Value) -> Result<(), String> {
    let tool = value["toolName"].as_str().ok_or("missing tool")?;
    if !["write", "edit", "bash"].contains(&tool) {
        return Ok(());
    }
    let Some(session) = value["sessionId"].as_str() else {
        return Ok(());
    };
    let workflows = storage
        .load_workflows_dto(session)
        .map_err(|e| e.to_string())?;
    let active: Vec<_> = workflows
        .iter()
        .filter(|workflow| !["rejected", "cancelled"].contains(&workflow.status.as_str()))
        .collect();
    // shell 无法从字符串可靠证明写入范围；只有活跃协作期间保守拒绝。
    // 文件工具则检查真实路径，允许无关文件写入，不永久锁死整个 Session。
    if active.is_empty() {
        return Ok(());
    }
    if tool != "bash" {
        let input: Value =
            serde_json::from_str(value["inputJson"].as_str().ok_or("missing tool input")?)
                .map_err(|_| "invalid tool input")?;
        if let Some(path) = input["path"]
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
        {
            let mut target = Path::new(path);
            while !target.exists() {
                target = target.parent().ok_or("invalid target")?;
            }
            let target = target.canonicalize().map_err(|_| "cannot resolve target")?;
            if active.iter().all(|workflow| {
                Path::new(&workflow.plan.repository)
                    .canonicalize()
                    .ok()
                    .is_some_and(|repository| !target.starts_with(repository))
                    && workflow.runs.iter().all(|run| {
                        run.workspace.as_deref().is_none_or(|workspace| {
                            Path::new(workspace)
                                .canonicalize()
                                .ok()
                                .is_some_and(|workspace| !target.starts_with(workspace))
                        })
                    })
            }) {
                return Ok(());
            }
        }
    }
    Err("active collaboration requires isolated work-item execution; native writes/shell cannot bypass the plan".into())
}

/// 无 WebView 的持久化路由：先验证结果，再允许适配层发送成功 ACK。
pub fn dispatch_operation(
    storage: &mut Storage,
    payload: &Value,
    now: i64,
) -> crate::HostResult<Value> {
    let operation = decode_operation_payload(payload).map_err(crate::HostError::InvalidRequest)?;
    dispatch_typed_operation(storage, operation, now)
}

fn dispatch_typed_operation(
    storage: &mut Storage,
    operation: WorkflowOperation,
    now: i64,
) -> crate::HostResult<Value> {
    let name = operation.name();
    let value = dispatch_typed_operation_inner(storage, operation, now)
        .map_err(crate::HostError::InvalidRequest)?;
    validate_operation_result(name, value)
}

fn dispatch_typed_operation_inner(
    storage: &mut Storage,
    operation: WorkflowOperation,
    now: i64,
) -> Result<Value, String> {
    match operation {
        // Agent 可以降低权限并暂停，不能借这个接口批准或恢复总计划。
        WorkflowOperation::Suspend(request) => storage
            .control_workflow(&request.workflow_id, "pause", now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::OperationAuthorize(request) => {
            let result = crate::workflow_policy::authorize_operation(storage, &request)?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }
        WorkflowOperation::RunPhaseRead(request) => storage
            .workflow_run_phase(&request.run_id)
            .map(|phase| json!(phase))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Find(request) => storage
            .find_workflows_dto(&request.name, &request.repository, &request.status)
            .and_then(|items| serde_json::to_value(items).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::List(request) => storage
            .load_workflows_dto(&request.session_id)
            .and_then(|items| serde_json::to_value(items).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Notifications(request) => storage
            .workflow_notifications_dto(&request.session_id)
            .and_then(|events| serde_json::to_value(events).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::CoordinatorClaim(request) => storage
            .claim_workflow(&request.workflow_id, &request.owner, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::CoordinatorRenew(request) => storage
            .renew_workflow_claim(&request.workflow_id, &request.owner, now)
            .map(|_| json!({"renewed":true}))
            .map_err(|error| error.to_string()),
        WorkflowOperation::CoordinatorFinish(request) => storage
            .finish_workflow_claim(
                &request.workflow_id,
                &request.owner,
                request.sequence,
                &request.checkpoint,
                request.progress,
                now,
            )
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::CoordinatorFail(request) => storage
            .fail_workflow_claim(&request.workflow_id, &request.owner, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::CoordinatorUnavailable(request) => storage
            .unavailable_workflow_coordinator(&request.workflow_id, &request.owner, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::RunPhase(request) => storage
            .mark_workflow_run_phase(&request.run_id, &request.phase, now)
            .map(|_| json!({"saved":true}))
            .map_err(|error| error.to_string()),
        WorkflowOperation::DelegateDecision(request) => storage
            .save_delegate_decision(
                &request.workflow_id,
                &request.run_id,
                &request.request_id,
                &request.kind,
                &request.decision,
                now,
            )
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::DelegateRequest(request) => storage
            .register_workflow_decision(
                &request.workflow_id,
                &request.run_id,
                &request.request_id,
                &request.kind,
                &request.input,
                now,
            )
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::DelegateResult(request) => storage
            .workflow_decision_result(&request.workflow_id, &request.request_id)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::ApplicationBegin(request) => storage
            .begin_workflow_application(&request.application_id, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::ApplicationFinish(request) => storage
            .finish_workflow_application(&request.application_id, request.applied, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Submit(plan) => store_typed_plan(storage, &plan, now, false),
        WorkflowOperation::Refine(plan) => store_typed_plan(storage, &plan, now, true),
        WorkflowOperation::Authorize(request) => storage
            .authorize_work_item(
                &request.workflow_id,
                request.version,
                &request.digest,
                &request.work_item_id,
            )
            .map(|_| json!({"authorized":true}))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Run(run) => storage
            .save_agent_run(&run, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Event(request) => storage
            .record_workflow_event(&request.workflow_id, &request.kind, &request.summary, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Finding(request) => storage
            .save_workflow_finding(&request.workflow_id, &request.finding, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Integration(request) => storage
            .save_integration_result(&request.workflow_id, &request.result, now)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
            .map_err(|error| error.to_string()),
        WorkflowOperation::Test(request) => {
            crate::research::ensure_task(storage, &request.run_id, now)?;
            storage
                .save_workflow_test(
                    &request.workflow_id,
                    &request.run_id,
                    &request.evidence,
                    &request.text,
                    now,
                )
                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                .map_err(|error| error.to_string())
        }
        WorkflowOperation::Consume(request) => storage
            .consume_workflow_events(&request.workflow_id, request.sequence)
            .map(|_| json!({"consumed":true}))
            .map_err(|error| error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn workflow_effects_do_not_republish_replays_or_wake_for_routine_activity() {
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot = submit(&mut db, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        let mut outcome = crate::rpc::RpcDispatchResult {
            result: semi_os_storage::RpcResult {
                ok: true,
                value: Some(snapshot),
                error: None,
            },
            replayed: false,
        };
        let mut request = json!({
            "operationId":"effects", "operation":"event",
            "value":{"workflowId":plan.workflow_id,"kind":"tool.activity","summary":"reading"}
        });
        let effects = operation_effects(&request, &outcome).unwrap();
        assert!(effects.snapshot.is_some());
        assert!(effects.notification.is_none());
        request["value"]["kind"] = json!("run.health");
        assert_eq!(
            operation_effects(&request, &outcome).unwrap().notification,
            Some("observe")
        );
        outcome.result.value.as_mut().unwrap()["status"] = json!("paused");
        assert_eq!(
            operation_effects(&request, &outcome).unwrap().notification,
            Some("pause")
        );
        outcome.replayed = true;
        let effects = operation_effects(&request, &outcome).unwrap();
        assert!(effects.snapshot.is_none());
        assert!(effects.notification.is_none());
        outcome.replayed = false;
        outcome.result.ok = false;
        outcome.result.value = None;
        outcome.result.error = Some("failed".into());
        let effects = operation_effects(&request, &outcome).unwrap();
        assert!(effects.snapshot.is_none());
        assert!(effects.notification.is_none());
    }

    #[test]
    fn workflow_claim_effects_require_valid_snapshot_and_do_not_wake_again() {
        let request = json!({
            "operationId":"claim", "operation":"coordinator.claim",
            "value":{"workflowId":"workflow_fixture","owner":"worker"}
        });
        let mut outcome = crate::rpc::RpcDispatchResult {
            result: semi_os_storage::RpcResult {
                ok: true,
                value: Some(json!({"claimed":false,"needsUser":false})),
                error: None,
            },
            replayed: false,
        };
        assert!(operation_effects(&request, &outcome)
            .unwrap()
            .snapshot
            .is_none());
        outcome.result.value =
            Some(json!({"claimed":true,"sequence":1,"snapshot":{},"events":[],"checkpoint":null}));
        assert!(operation_effects(&request, &outcome).is_err());
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot = submit(&mut db, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        let events = snapshot["events"].clone();
        outcome.result.value.as_mut().unwrap()["sequence"] =
            events.as_array().unwrap().last().unwrap()["sequence"].clone();
        outcome.result.value.as_mut().unwrap()["events"] = events;
        outcome.result.value.as_mut().unwrap()["snapshot"] = snapshot;
        let effects = operation_effects(&request, &outcome).unwrap();
        assert!(effects.snapshot.is_some());
        assert!(effects.notification.is_none());
    }

    #[test]
    fn malformed_operations_are_rejected_before_storage_changes() {
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        submit(&mut db, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        let before = db.load_workflow_dto(&plan.workflow_id).unwrap().unwrap();
        let event = json!({"workflowId":plan.workflow_id,"kind":"fixture","summary":"once"});
        let payload = |operation: &str, value: Value| json!({"operationId":"op_fixture","operation":operation,"value":value});
        for (request, expected) in [
            (
                payload("unknown", json!({})),
                "unsupported workflow operation",
            ),
            (
                payload(
                    "event",
                    json!({"workflowId":plan.workflow_id,"kind":"fixture"}),
                ),
                "summary",
            ),
            (
                payload(
                    "event",
                    json!({"workflowId":plan.workflow_id,"kind":"fixture","summary":1}),
                ),
                "invalid type",
            ),
            (
                payload(
                    "event",
                    json!({"workflowId":plan.workflow_id,"kind":"fixture","summary":"once","approved":true}),
                ),
                "unknown field",
            ),
            (
                json!({"operationId":"op_fixture","operation":"event","value":event,"approved":true}),
                "unknown field",
            ),
            (
                json!({"operationId":" ","operation":"event","value":event}),
                "missing operationId",
            ),
            (payload("find", json!({"name":42})), "invalid type"),
            (payload("find", json!({"status":null})), "invalid type"),
        ] {
            let error = dispatch_operation(&mut db, &request, 3).unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
            assert_eq!(
                serde_json::to_value(db.load_workflow_dto(&plan.workflow_id).unwrap().unwrap())
                    .unwrap(),
                serde_json::to_value(&before).unwrap(),
            );
        }
    }

    #[test]
    fn typed_dispatch_preserves_wire_shape_and_default_find_filters() {
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot = dispatch_operation(
            &mut db,
            &json!({"operationId":"op_submit","operation":"submit","value":plan}),
            2,
        )
        .unwrap();
        assert_eq!(snapshot["plan"]["workflowId"], plan.workflow_id);
        let all = dispatch_operation(
            &mut db,
            &json!({"operationId":"op_find","operation":"find","value":{}}),
            3,
        )
        .unwrap();
        assert_eq!(all.as_array().unwrap().len(), 1);
        assert_eq!(all[0]["plan"]["workflowId"], plan.workflow_id);
    }

    #[test]
    fn background_bridge_only_decodes_operations_it_owns() {
        let mut db = Storage::open_in_memory().unwrap();
        for operation in ["submit", "list", "unknown"] {
            assert!(background_operation(&mut db, operation, &Value::Null, 1).is_none());
        }
        assert!(
            background_operation(&mut db, "coordinator.unknown", &json!({}), 1)
                .unwrap()
                .is_err()
        );
        assert!(background_operation(&mut db, "suspend", &json!({}), 1)
            .unwrap()
            .is_err());
        assert_eq!(
            background_operation(&mut db, "find", &json!({}), 1)
                .unwrap()
                .unwrap(),
            json!([]),
        );
    }

    #[test]
    fn snapshot_ack_requires_typed_result_before_reporting_success() {
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot = submit(&mut db, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        assert_eq!(
            validate_operation_result("submit", snapshot.clone()).unwrap(),
            snapshot
        );
        let mut malformed = snapshot.clone();
        malformed["runs"] = json!("invalid");
        assert!(validate_operation_result("run", malformed.clone()).is_err());
        assert!(validate_operation_result(
            "coordinator.claim",
            json!({"claimed":true,"snapshot":malformed})
        )
        .is_err());
        assert!(validate_operation_result(
            "coordinator.claim",
            json!({"claimed":true,"sequence":1,"events":[snapshot["events"][0].clone()],
                "snapshot":snapshot,"checkpoint":null})
        )
        .is_ok());
        for (operation, value) in [
            (
                "coordinator.claim",
                json!({"claimed":false,"needsUser":true}),
            ),
            ("authorize", json!({"authorized":true})),
            ("consume", json!({"consumed":true})),
        ] {
            assert_eq!(
                validate_operation_result(operation, value.clone()).unwrap(),
                value
            );
        }
    }

    #[test]
    fn durable_dispatch_deduplicates_events_but_rechecks_expired_leases() {
        use semi_os_protocol::{Envelope, EnvelopeContext, RequestId};
        let mut db = Storage::open_in_memory().unwrap();
        let plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let make = |id: &str, operation: &str, value: Value| Envelope::Event {
            protocol_version: 1,
            request_id: RequestId(id.into()),
            kind: "workflow.request".into(),
            payload: json!({"operationId":id,"operation":operation,"value":value}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        let submitted = dispatch_request(
            &mut db,
            &make("req_submit", "submit", serde_json::to_value(&plan).unwrap()),
            2,
        )
        .unwrap();
        db.decide_workflow(
            &plan.workflow_id,
            plan.version,
            submitted.result.value.unwrap()["digest"].as_str().unwrap(),
            "approved",
            3,
        )
        .unwrap();
        let message = make(
            "req_event",
            "event",
            json!({"workflowId":plan.workflow_id,"kind":"fixture","summary":"once"}),
        );
        let first = dispatch_request(&mut db, &message, 4).unwrap();
        let replay = dispatch_request(&mut db, &message, 5).unwrap();
        assert!(replay.replayed);
        assert_eq!(first.result, replay.result);
        assert_eq!(
            db.load_workflow_dto(&plan.workflow_id)
                .unwrap()
                .unwrap()
                .events
                .iter()
                .filter(|event| event.kind == "fixture")
                .count(),
            1
        );
        let claim = make(
            "req_claim",
            "coordinator.claim",
            json!({"workflowId":plan.workflow_id,"owner":"fixture"}),
        );
        let result = dispatch_request(&mut db, &claim, 6).unwrap();
        assert_eq!(result.result.value.unwrap()["claimed"], true);
        // 相同请求身份也必须检查实时租约，不能重放过去的 claimed=true。
        let expired = dispatch_request(&mut db, &claim, 100_000).unwrap();
        assert!(!expired.replayed);
        assert_eq!(expired.result.value.unwrap()["claimed"], false);
        let renew = make(
            "req_renew",
            "coordinator.renew",
            json!({"workflowId":plan.workflow_id,"owner":"fixture"}),
        );
        assert!(
            !dispatch_request(&mut db, &renew, 100_001)
                .unwrap()
                .result
                .ok
        );
    }

    #[test]
    fn active_workflow_prevents_native_mutation_bypass_and_preserves_unrelated_files() {
        let directory = std::env::temp_dir().join(format!(
            "semi-host-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repository = directory.join("source");
        let unrelated = directory.join("unrelated");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        let mut db = Storage::open_in_memory().unwrap();
        let mut plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        plan.repository = repository.to_str().unwrap().into();
        db.create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot = submit(&mut db, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        let operation = |tool: &str, path: &Path| {
            json!({
                "sessionId": plan.session_id, "toolName": tool,
                "inputJson": json!({"path": path}).to_string(),
            })
        };
        assert!(guard_native_operation(&db, &operation("read", &repository)).is_ok());
        assert!(guard_native_operation(&db, &operation("bash", &unrelated)).is_err());
        assert!(
            guard_native_operation(&db, &operation("write", &repository.join("new/file"))).is_err()
        );
        assert!(guard_native_operation(&db, &operation("edit", Path::new("relative"))).is_err());
        assert!(
            guard_native_operation(&db, &operation("write", &unrelated.join("new/file"))).is_ok()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&repository, unrelated.join("alias")).unwrap();
            assert!(
                guard_native_operation(&db, &operation("write", &unrelated.join("alias/new")))
                    .is_err()
            );
        }
        db.decide_workflow(
            &plan.workflow_id,
            plan.version,
            snapshot["digest"].as_str().unwrap(),
            "approved",
            3,
        )
        .unwrap();
        assert!(guard_native_operation(&db, &operation("write", &repository)).is_err());
        db.control_workflow(&plan.workflow_id, "cancel", 4).unwrap();
        assert!(guard_native_operation(&db, &operation("bash", &repository)).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }
}
