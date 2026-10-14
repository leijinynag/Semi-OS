use semi_os_protocol::{AuthorizedAction, ToolRiskLevel, WorkRole};
use semi_os_storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

fn bounded_path(workspace: &Path, target: &str) -> Result<(), String> {
    let root = workspace.canonicalize().map_err(|_| "missing workspace")?;
    let path = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        root.join(target)
    };
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("parent traversal requires user authorization".into());
    }
    let mut existing = path.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("invalid path")?;
    }
    if !existing
        .canonicalize()
        .map_err(|_| "invalid path")?
        .starts_with(root)
    {
        return Err("operation outside registered workspace".into());
    }
    Ok(())
}

/// 只接受可证明的简单读取命令，不用 startsWith("git") 等模糊分类。
/// 不运行 shell 来“检测”风险；重定向、展开、管道、未知选项一律需真人批准。
pub fn readonly_command(command: &str, workspace: &Path) -> bool {
    let Some(mut words) = shlex::split(command) else {
        return false;
    };
    if words.len() == 3
        && ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].contains(&words[0].as_str())
        && ["-lc", "-c"].contains(&words[1].as_str())
    {
        let Some(inner) = shlex::split(&words[2]) else {
            return false;
        };
        if words[2].contains([
            ';', '|', '&', '>', '<', '$', '`', '\n', '\r', '*', '?', '~', '\\',
        ]) {
            return false;
        }
        words = inner;
    } else if command.contains([
        ';', '|', '&', '>', '<', '$', '`', '\n', '\r', '*', '?', '~', '\\',
    ]) {
        return false;
    }
    let Some(program) = words.first().map(String::as_str) else {
        return false;
    };
    let program = match program {
        "/bin/cat" => "cat",
        "/bin/ls" => "ls",
        "/bin/pwd" => "pwd",
        value => value,
    };
    let arguments = &words[1..];
    match program {
        "pwd" => arguments.is_empty(),
        "cat" => {
            !arguments.is_empty()
                && arguments
                    .iter()
                    .all(|arg| !arg.starts_with('-') && bounded_path(workspace, arg).is_ok())
        }
        "ls" => arguments.iter().all(|arg| {
            ["-l", "-a", "-la", "-al", "-lh"].contains(&arg.as_str())
                || !arg.starts_with('-') && bounded_path(workspace, arg).is_ok()
        }),
        "git" => match arguments
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["rev-parse", "HEAD"] => true,
            // status 可能执行仓库配置的 fsmonitor；只有显式关闭后才自动批准。
            ["-c", "core.fsmonitor=false", "status"]
            | ["-c", "core.fsmonitor=false", "status", "--short"]
            | ["-c", "core.fsmonitor=false", "status", "--porcelain"] => true,
            ["diff", "--no-ext-diff", "--no-textconv"] => true,
            // diff 默认可能执行外部 diff/textconv，必须显式关闭；用 -- 避免文件被当作选项。
            ["diff", "--no-ext-diff", "--no-textconv", "--", path] => {
                bounded_path(workspace, path).is_ok()
            }
            _ => false,
        },
        _ => false,
    }
}

/// 托管权限由 Host 重查计划、工作项、实际工作区与动作。cwd 不是沙箱：
/// 不能证明边界的 shell/批量修改仍返回 confirmation，而非自动降级。
///
/// Provider 的工具参数仍是开放对象，但授权身份不允许依靠任意 JSON 索引推断。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAuthorizationRequest {
    pub workflow_id: String,
    pub run_id: String,
    pub tool: String,
    pub input: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAuthorizationResult {
    pub risk: ToolRiskLevel,
    pub delegated: bool,
}

impl WorkflowAuthorizationResult {
    fn confirmation() -> Self {
        Self {
            risk: ToolRiskLevel::ExternalSideEffect,
            delegated: false,
        }
    }
}

pub fn authorize_operation(
    storage: &Storage,
    request: &WorkflowAuthorizationRequest,
) -> Result<WorkflowAuthorizationResult, String> {
    let id = &request.workflow_id;
    let snapshot = storage
        .load_workflow_dto(id)
        .map_err(|e| e.to_string())?
        .ok_or("unknown workflow")?;
    let plan = &snapshot.plan;
    let run = snapshot
        .runs
        .iter()
        .find(|run| run.run_id == request.run_id)
        .ok_or("unknown run")?;
    let validation = request.tool == "workspace_test" && run.status == "completed";
    if run.intent_version != plan.intent_version || run.status != "running" && !validation {
        return Err("stale execution".into());
    }
    let item = &run.work_item_id;
    storage
        .authorize_work_item(id, plan.version, &snapshot.digest, item)
        .map_err(|e| e.to_string())?;
    let role = plan
        .work_items
        .iter()
        .find(|work| work.work_item_id == *item)
        .ok_or("missing work item")?;
    let workspace = Path::new(run.workspace.as_deref().ok_or("missing workspace")?);
    let input = &request.input;
    let grant_matches = snapshot
        .background
        .grant
        .as_ref()
        .is_some_and(|grant| grant.intent_version == plan.intent_version);
    if validation {
        // Host 指定的限制由受控 runner 执行；不把“cwd 正确”当作沙箱证明。
        let delegated = cfg!(target_os = "macos")
            && Path::new("/usr/bin/sandbox-exec").is_file()
            && input.get("confinement").and_then(Value::as_str) == Some("macos-seatbelt-v1")
            && role.role == WorkRole::Integration
            && plan
                .authorized_actions
                .contains(&AuthorizedAction::WorkspaceWrite)
            && grant_matches
            && run.revision.as_deref().is_some_and(|revision| {
                input.get("revision").and_then(Value::as_str) == Some(revision)
            });
        return Ok(WorkflowAuthorizationResult {
            risk: if delegated {
                ToolRiskLevel::LocalWrite
            } else {
                ToolRiskLevel::ExternalSideEffect
            },
            delegated,
        });
    }
    if input
        .get("cwd")
        .and_then(Value::as_str)
        .is_some_and(|cwd| Path::new(cwd).canonicalize().ok() != workspace.canonicalize().ok())
    {
        return Ok(WorkflowAuthorizationResult::confirmation());
    }
    let tool = request.tool.as_str();
    let read = ["read", "Read", "grep", "Grep", "find", "Glob", "ls"].contains(&tool);
    let write = ["write", "Write", "edit", "Edit"].contains(&tool);
    if read || write {
        let target = input
            .get("path")
            .and_then(Value::as_str)
            .or(input.get("file_path").and_then(Value::as_str))
            .unwrap_or(".");
        bounded_path(workspace, target)?;
        for key in ["paths", "files"] {
            if input.get(key).is_some() {
                return Ok(WorkflowAuthorizationResult::confirmation());
            }
        }
        for key in ["cwd", "directory", "root"] {
            if let Some(path) = input.get(key).and_then(Value::as_str) {
                bounded_path(workspace, path)?;
            }
        }
        if read {
            return Ok(WorkflowAuthorizationResult {
                risk: ToolRiskLevel::Read,
                delegated: true,
            });
        }
        if role.role.is_writing()
            && snapshot.status == "approved"
            && grant_matches
            && plan
                .authorized_actions
                .contains(&AuthorizedAction::WorkspaceWrite)
        {
            return Ok(WorkflowAuthorizationResult {
                risk: ToolRiskLevel::LocalWrite,
                delegated: true,
            });
        }
        return Err("write outside delegated scope".into());
    }
    if ["bash", "Bash"].contains(&tool) {
        if let Some(command) = input.get("command").and_then(Value::as_str) {
            if readonly_command(command, workspace) {
                return Ok(WorkflowAuthorizationResult {
                    risk: ToolRiskLevel::Read,
                    delegated: true,
                });
            }
        }
    }
    Ok(WorkflowAuthorizationResult::confirmation())
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_protocol::{AgentRun, WorkflowPlan};
    use serde_json::json;

    fn operation(tool: &str, input: Value) -> Value {
        json!({
            "workflowId":"workflow_fixture", "runId":"run_fixture",
            "tool":tool, "input":input,
        })
    }

    #[test]
    fn authorization_boundary_rejects_malformed_identity_and_nonobject_input() {
        let mut storage = Storage::open_in_memory().unwrap();
        let missing_run = crate::workflow::background_operation(
            &mut storage,
            "operation.authorize",
            &json!({"workflowId":"workflow_fixture","tool":"Read","input":{}}),
            1,
        )
        .unwrap()
        .unwrap_err();
        assert!(missing_run.starts_with("invalid operation.authorize payload:"));
        assert!(missing_run.contains("runId"));
        for request in [
            operation("Read", Value::Null),
            operation("Read", json!([])),
            operation("Read", json!("path")),
        ] {
            let result = crate::workflow::background_operation(
                &mut storage,
                "operation.authorize",
                &request,
                1,
            )
            .unwrap();
            let error = result.unwrap_err();
            assert!(error.starts_with("invalid operation.authorize payload:"));
            assert!(error.contains("invalid type"));
        }
        let mut request = operation("Read", json!({}));
        request["approved"] = true.into();
        assert!(serde_json::from_value::<WorkflowAuthorizationRequest>(request).is_err());
    }

    #[test]
    fn typed_policy_preserves_grant_scope_and_rejects_stale_operations() {
        let directory = std::env::temp_dir().join(format!(
            "semi-typed-policy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut storage = Storage::open_in_memory().unwrap();
        let mut plan: WorkflowPlan = serde_json::from_str(include_str!(
            "../../../tests/contract/fixtures/workflow-plan.json"
        ))
        .unwrap();
        // 合成单工作项去除依赖，测试只关注 Host 的授权与 DTO 边界。
        plan.work_items.truncate(1);
        plan.work_items[0].role = WorkRole::Implementation;
        plan.repository = directory.to_str().unwrap().into();
        storage
            .create_client_session(&plan.session_id, "fixture", 1)
            .unwrap();
        let snapshot =
            crate::workflow::submit(&mut storage, serde_json::to_value(&plan).unwrap(), 2).unwrap();
        storage
            .decide_workflow(
                &plan.workflow_id,
                1,
                snapshot["digest"].as_str().unwrap(),
                "approved",
                3,
            )
            .unwrap();
        let mut run: AgentRun = serde_json::from_value(json!({
            "runId":"run_fixture", "workflowId":plan.workflow_id,
            "planVersion":1, "intentVersion":1, "workItemId":plan.work_items[0].work_item_id,
            "attempt":1, "provider":plan.work_items[0].provider,
            "status":"queued", "startedAtMs":4
        }))
        .unwrap();
        storage.save_agent_run(&run, 4).unwrap();
        run.status = "running".into();
        run.workspace = Some(directory.to_str().unwrap().into());
        run.branch = Some("codex/run_fixture".into());
        run.baseline_commit = Some("a".repeat(40));
        storage.save_agent_run(&run, 5).unwrap();

        let authorize = |storage: &mut Storage, tool: &str, input: Value| {
            crate::workflow::background_operation(
                storage,
                "operation.authorize",
                &operation(tool, input),
                6,
            )
            .unwrap()
        };
        assert_eq!(
            authorize(&mut storage, "Read", json!({"file_path":"file.txt"})).unwrap(),
            json!({"risk":"read","delegated":true})
        );
        assert_eq!(
            authorize(&mut storage, "Write", json!({"file_path":"file.txt"})).unwrap(),
            json!({"risk":"local_write","delegated":true})
        );
        assert_eq!(
            authorize(&mut storage, "Bash", json!({"command":"pwd"})).unwrap(),
            json!({"risk":"read","delegated":true})
        );
        for (tool, input) in [
            ("Bash", json!({"command":"touch file.txt"})),
            ("Write", json!({"paths":["file.txt"]})),
            ("unknown_tool", json!({})),
        ] {
            assert_eq!(
                authorize(&mut storage, tool, input).unwrap(),
                json!({"risk":"external_side_effect","delegated":false})
            );
        }
        assert!(authorize(&mut storage, "Read", json!({"file_path":"../secret"})).is_err());
        let before = storage
            .load_workflow_dto(&plan.workflow_id)
            .unwrap()
            .unwrap()
            .events
            .len();
        // 非法 JSON 在 Host DTO 边界拒绝，不能进入类型化 Storage 写入接口。
        assert!(
            serde_json::from_value::<semi_os_storage::WorkflowDecisionInput>(
                json!({"questions":[{"question":"选择？","multiSelect":"yes"}]})
            )
            .is_err()
        );
        let snapshot = storage
            .load_workflow_dto(&plan.workflow_id)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.events.len(), before);
        assert!(snapshot.background.requests.is_empty());
        let question = json!({"questions":[{
            "question":"选择？","header":"方案","multiSelect":true,
            "options":[{"label":"A","description":"方案 A"}]
        }]});
        storage
            .register_workflow_decision(
                &plan.workflow_id,
                &run.run_id,
                "question",
                "clarification",
                &serde_json::from_value(question.clone()).unwrap(),
                8,
            )
            .unwrap();
        let snapshot = storage
            .load_workflow_dto(&plan.workflow_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&snapshot.background.requests[0].input).unwrap(),
            question
        );
        storage
            .control_workflow(&plan.workflow_id, "pause", 9)
            .unwrap();
        assert!(authorize(&mut storage, "Write", json!({"file_path":"file.txt"})).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shell_parser_rejects_hidden_mutation_and_unknown_options() {
        let root = std::env::temp_dir();
        assert!(readonly_command("pwd", &root));
        assert!(readonly_command(
            "/bin/zsh -lc 'git -c core.fsmonitor=false status --short'",
            &root
        ));
        assert!(readonly_command("/bin/cat fixture.txt", &root));
        assert!(!readonly_command("cat /etc/passwd", &root));
        for command in [
            "cat ../secret",
            "git -C / status",
            "git config x y",
            "git diff",
            "ls; rm x",
            "cat $(touch x)",
            "ls > out",
            "node -e 'process.exit()'",
            "cat --help",
            "git status && touch x",
            "git status",
            "git status --short",
            "git -c core.fsmonitor=./hook status",
        ] {
            assert!(!readonly_command(command, &root), "{command}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn shell_parser_rejects_symlinks_leaving_registered_workspace() {
        let directory = std::env::temp_dir().join(format!("semi-policy-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let link = directory.join("outside");
        std::os::unix::fs::symlink("/etc", &link).unwrap();
        assert!(!readonly_command("cat outside/passwd", &directory));
        assert!(!readonly_command("ls outside", &directory));
        assert!(!readonly_command(
            "git diff --no-ext-diff --no-textconv -- outside/passwd",
            &directory
        ));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
