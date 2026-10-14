use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingProvider {
    Pi,
    Claude,
    Codex,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkRole {
    Research,
    Planning,
    Review,
    Implementation,
    Integration,
    Verification,
}
impl WorkRole {
    pub fn is_writing(&self) -> bool {
        matches!(self, Self::Implementation | Self::Integration)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizedAction {
    Read,
    WorkspaceWrite,
    LocalCommit,
    Integrate,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItem {
    pub work_item_id: String,
    pub title: String,
    pub objective: String,
    pub role: WorkRole,
    pub provider: CodingProvider,
    pub dependencies: Vec<String>,
    pub outputs: Vec<String>,
    pub acceptance: Vec<String>,
}
/// 与 Node 共享的计划载荷。版本不可覆盖；用户批准独立保存，不能嵌在模型提案中。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPlan {
    pub workflow_id: String,
    pub session_id: String,
    pub version: u32,
    pub intent_version: u32,
    pub title: String,
    pub goal: String,
    pub scope: Vec<String>,
    pub acceptance: Vec<String>,
    pub authorized_actions: Vec<AuthorizedAction>,
    pub repository: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_commit: Option<String>,
    pub work_items: Vec<WorkItem>,
}

/// 一次执行尝试独立保存；旧版本及取消后的成果不能覆盖新意图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRun {
    pub run_id: String,
    pub workflow_id: String,
    pub plan_version: u32,
    pub intent_version: u32,
    pub work_item_id: String,
    pub attempt: u32,
    pub provider: CodingProvider,
    pub status: String,
    pub started_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<AgentPermission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderCapabilities>,
}
/// 实际能力由 Adapter 声明并跨进程保存，界面不能按 Provider 名称猜测。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCapabilities {
    pub steer: bool,
    pub pause: bool,
    pub resume: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPermission {
    pub request_id: String,
    pub tool: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFinding {
    pub finding_id: String,
    pub work_item_id: String,
    pub revision: String,
    pub summary: String,
    pub status: String,
    pub rework_rounds: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestEvidence {
    pub command: String,
    pub exit_code: i32,
    pub revision: String,
    pub artifact_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewEvidence {
    pub run_id: String,
    pub revision: String,
    pub finding_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationResult {
    pub revision: String,
    pub branch: String,
    pub workspace: String,
    pub commits: Vec<String>,
    pub status: String,
    pub tests: Vec<TestEvidence>,
    pub reviews: Vec<ReviewEvidence>,
}
impl AgentRun {
    pub fn provider_name(&self) -> &'static str {
        match self.provider {
            CodingProvider::Pi => "pi",
            CodingProvider::Claude => "claude",
            CodingProvider::Codex => "codex",
        }
    }
}

/// Host 再次检查边界和无环性，不相信 Worker 已校验的声明。
pub fn validate_workflow_plan(plan: &WorkflowPlan) -> Result<(), String> {
    fn text(s: &str, max: usize) -> bool {
        !s.trim().is_empty() && s.encode_utf16().count() <= max && !s.contains('\0')
    }
    fn id(s: &str) -> bool {
        text(s, 160)
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }
    fn list(items: &[String], nonempty: bool) -> bool {
        (!nonempty || !items.is_empty())
            && items.len() <= 100
            && items.iter().all(|s| text(s, 8_000))
    }
    if !id(&plan.workflow_id)
        || !id(&plan.session_id)
        || plan.version == 0
        || plan.intent_version == 0
        || !text(&plan.title, 160)
        || !text(&plan.goal, 8_000)
        || !list(&plan.scope, true)
        || !list(&plan.acceptance, true)
        || !text(&plan.repository, 4_096)
        || !plan.repository.starts_with('/')
        || plan.repository.contains('\n')
    {
        return Err("invalid workflow identity or scope".into());
    }
    if plan.baseline_commit.as_ref().is_some_and(|s| {
        !matches!(s.len(), 40 | 64)
            || !s
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    }) {
        return Err("baseline must be an exact commit".into());
    }
    let actions = &plan.authorized_actions;
    if !actions.contains(&AuthorizedAction::Read)
        || actions
            .iter()
            .enumerate()
            .any(|(i, a)| actions[..i].contains(a))
        || actions.contains(&AuthorizedAction::Integrate)
            && !actions.contains(&AuthorizedAction::LocalCommit)
    {
        return Err("invalid authorized actions".into());
    }
    if plan.work_items.is_empty() || plan.work_items.len() > 100 {
        return Err("invalid work items".into());
    }
    let items: HashMap<_, _> = plan
        .work_items
        .iter()
        .map(|item| (item.work_item_id.as_str(), item))
        .collect();
    if items.len() != plan.work_items.len() {
        return Err("duplicate work item".into());
    }
    for item in &plan.work_items {
        if !id(&item.work_item_id)
            || !text(&item.title, 160)
            || !text(&item.objective, 8_000)
            || !list(&item.outputs, true)
            || !list(&item.acceptance, true)
            || !list(&item.dependencies, false)
            || item.dependencies.iter().any(|s| !id(s))
            || item.dependencies.iter().collect::<HashSet<_>>().len() != item.dependencies.len()
        {
            return Err("invalid work item".into());
        }
        if item.role.is_writing() && !actions.contains(&AuthorizedAction::WorkspaceWrite) {
            return Err("writing task is outside authorization".into());
        }
    }
    fn visit<'a>(
        id: &'a str,
        items: &HashMap<&'a str, &'a WorkItem>,
        visited: &mut HashSet<&'a str>,
        visiting: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err("cyclic work dependencies".into());
        }
        let item = items.get(id).ok_or("unknown work dependency")?;
        for dependency in &item.dependencies {
            visit(dependency, items, visited, visiting)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    let mut visited = HashSet::new();
    for item in &plan.work_items {
        visit(
            &item.work_item_id,
            &items,
            &mut visited,
            &mut HashSet::new(),
        )?;
    }
    Ok(())
}

/// 应用源分支需用户另行批准，不能由 Worker 提交计划时顺带授权。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowApplication {
    pub application_id: String,
    pub workflow_id: String,
    pub version: u32,
    pub digest: String,
    pub repository: String,
    pub workspace: String,
    pub expected_ref: String,
    pub expected_head: String,
    pub revision: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_fixture_checks_dag_and_rejects_injected_approval() {
        let raw = include_str!("../../../tests/contract/fixtures/workflow-plan.json");
        let mut plan: WorkflowPlan = serde_json::from_str(raw).unwrap();
        validate_workflow_plan(&plan).unwrap();
        plan.work_items[0].dependencies.push("implement".into());
        assert!(validate_workflow_plan(&plan).is_err());
        let mut value: serde_json::Value = serde_json::from_str(raw).unwrap();
        value["approved"] = true.into();
        assert!(serde_json::from_value::<WorkflowPlan>(value).is_err());
    }
}
