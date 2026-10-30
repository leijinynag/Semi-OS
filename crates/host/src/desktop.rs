//! Host 独占桌面租约、引用与验证。观察没有授权含义；授权不可由模型参数声明。
use semi_os_desktop_macos::{
    DesktopAction, DesktopDriver, NativeElement, NativeObservation, ObservationError,
};
use semi_os_protocol::messages::{
    PayloadDesktopElement, PayloadDesktopObservation, PayloadDesktopPermissions,
    PayloadDesktopResult,
};
use std::collections::HashMap;

const OBSERVATION_TTL_MS: u64 = 15_000;

struct Observation {
    version: String,
    at: u64,
    input_epoch: u64,
    native: NativeObservation,
}

/// 授权值由 Host 的真人确认记录生成；Node 不可直接构造或发送该值。
pub struct DesktopAuthorization {
    task_id: String,
    generation: u64,
    allow_external: bool,
    action: String,
}

pub struct DesktopService<D: DesktopDriver> {
    driver: D,
    boot_id: String,
    generation: u64,
    sequence: u64,
    owner: Option<String>,
    owner_epoch: u64,
    paused: bool,
    operation: Option<(String, String)>,
    observations: HashMap<String, Observation>,
    /// 上一次看到的权限指纹（accessibility / screen_recording / input_monitoring）。
    /// 权限是能力输入而非授权：任何方向的变化都必须让旧租约和旧 AX 引用失效。
    last_permissions: Option<(String, String, String)>,
}

impl<D: DesktopDriver> DesktopService<D> {
    pub fn new(driver: D, boot_id: String) -> Self {
        Self {
            driver,
            boot_id,
            generation: 0,
            sequence: 0,
            owner: None,
            owner_epoch: 0,
            paused: false,
            operation: None,
            observations: HashMap::new(),
            last_permissions: None,
        }
    }

    /// 迟到的取消只能影响同一启动代次内的同一个请求，不得暂停新的动作。
    pub fn begin_operation(&mut self, task: &str, operation: &str) {
        self.operation = Some((task.into(), operation.into()));
    }

    pub fn cancel_operation(&mut self, task: &str, operation: &str) -> bool {
        if self
            .operation
            .as_ref()
            .is_some_and(|(t, o)| t == task && o == operation)
        {
            self.pause();
            true
        } else {
            false
        }
    }

    pub fn permissions(&mut self, now: u64) -> PayloadDesktopPermissions {
        let snapshot = self.driver.permissions(now);
        let fingerprint = (
            snapshot.accessibility.clone(),
            snapshot.screen_recording.clone(),
            snapshot.input_monitoring.clone(),
        );
        // 首次读取不做“变化”判定，否则启动时就会误废掉用户刚建立的租约。
        let changed = self
            .last_permissions
            .as_ref()
            .is_some_and(|previous| *previous != fingerprint);
        self.last_permissions = Some(fingerprint);
        if changed || !snapshot.takeover_detection || snapshot.accessibility != "granted" {
            self.revoke();
        }
        snapshot
    }

    /// 授权申请被系统处理后调用。
    ///
    /// 授权成功代表 OS 能力边界改变：授权前建立的观察句柄可能指向已经不可
    /// 访问的元素，必须在派发下一次动作前作废，不能把旧引用带上新权限。
    pub fn apply_permission_change(
        &mut self,
        granted: bool,
        now: u64,
    ) -> PayloadDesktopPermissions {
        if granted {
            self.revoke();
            self.driver.recover_input_monitor();
        }
        self.permissions(now)
    }

    /// 查询失败监听仍保持停用；只有用户明确重新检查时才重建，且旧批准永不复活。
    pub fn recheck_permissions_by_user(&mut self, now: u64) -> PayloadDesktopPermissions {
        if !self.driver.monitor_healthy() {
            self.revoke();
            self.driver.recover_input_monitor();
        }
        self.permissions(now)
    }

    /// 只由用户控制入口/已批准的前台操作调用。后台每次必须先获得真人占用批准。
    pub fn acquire(&mut self, task: &str, user_approved: bool) -> Result<(), String> {
        if !user_approved || task.trim().is_empty() || self.paused {
            return Err("需要用户批准占用桌面或明确恢复".into());
        }
        if !self.driver.monitor_healthy() {
            return Err("人工接管监听不可用，已禁止桌面动作".into());
        }
        if self.owner.as_deref().is_some_and(|owner| owner != task) {
            return Err("桌面正由其他任务占用".into());
        }
        self.generation += 1;
        self.owner = Some(task.into());
        self.owner_epoch = self.driver.input_epoch();
        self.observations.retain(|key, _| key == task);
        Ok(())
    }

    /// 观察可以在没有变更批准时建立任务上下文；真正的变更仍由 Host
    /// 在动作入口检查批准并取得独占租约。
    pub fn ensure_owner(&mut self, task: &str, user_approved: bool) -> Result<(), String> {
        if self.owner.as_deref() == Some(task) {
            if self.paused {
                return Err("桌面已暂停，请明确恢复".into());
            }
            return Ok(());
        }
        self.acquire(task, user_approved)
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    pub fn lease_generation(&self) -> u64 {
        self.generation
    }

    fn authorize(&self, task: &str, allow_external: bool) -> Result<DesktopAuthorization, String> {
        if self.owner.as_deref() != Some(task) || self.paused {
            return Err("桌面租约不可用".into());
        }
        Ok(DesktopAuthorization {
            task_id: task.into(),
            generation: self.generation,
            allow_external,
            action: String::new(),
        })
    }

    pub fn authorize_action(
        &self,
        task: &str,
        action: &DesktopAction,
        allow_external: bool,
    ) -> Result<DesktopAuthorization, String> {
        let mut token = self.authorize(task, allow_external)?;
        token.action = serde_json::to_string(action).map_err(|_| "invalid desktop action")?;
        Ok(token)
    }

    pub fn pause(&mut self) {
        self.paused = true;
        self.revoke();
    }

    /// “已手动处理”只解除暂停并废弃引用，不把操作标记成功。
    pub fn resume_by_user(&mut self) {
        self.paused = false;
        self.revoke();
        self.driver.recover_input_monitor();
    }

    pub fn revoke(&mut self) {
        self.generation += 1;
        self.owner = None;
        self.observations.clear();
        self.operation = None;
    }

    fn result(&self, status: &str, summary: &str) -> PayloadDesktopResult {
        PayloadDesktopResult {
            status: status.into(),
            summary: summary.into(),
            lease_generation: self.generation,
            observation: None,
            evidence: None,
        }
    }

    pub fn execute(
        &mut self,
        task: &str,
        action: &DesktopAction,
        authorization: Option<&DesktopAuthorization>,
        now: u64,
    ) -> PayloadDesktopResult {
        let permissions = self.permissions(now);
        if permissions.accessibility != "granted" {
            return self.result("needs_user", "需要 Accessibility 权限；文字对话仍可使用");
        }
        if self.owner.is_some() && self.owner_epoch != self.driver.input_epoch() {
            self.pause();
            return self.result("needs_user", "检测到人工接管，已让出桌面；请明确恢复");
        }
        if matches!(action, DesktopAction::Observe) {
            return match self.observe(task, now) {
                Ok(observation) => {
                    let mut result = self.result("observed", "已读取前台窗口语义");
                    result.observation = Some(observation);
                    result
                }
                Err(error) => self.result("needs_user", error.ui_message()),
            };
        }
        if self.paused || !permissions.takeover_detection {
            return self.result("needs_user", "桌面已暂停或人工接管监听不可用");
        }
        let Some(authorization) = authorization else {
            return self.result("needs_user", "需要授权本次桌面操作");
        };
        if authorization.task_id != task
            || authorization.generation != self.generation
            || self.owner.as_deref() != Some(task)
        {
            return self.result("needs_user", "授权不属于当前任务或租约");
        }
        if serde_json::to_string(action).ok().as_deref() != Some(&authorization.action) {
            return self.result("needs_user", "批准参数与本次动作不一致");
        }
        if let DesktopAction::LaunchApp { bundle_id } = action {
            if !authorization.allow_external {
                return self.result("needs_user", "启动应用需要准确参数的授权");
            }
            if self.driver.input_epoch() != self.owner_epoch || !self.driver.monitor_healthy() {
                self.pause();
                return self.result("needs_user", "人工接管或监听失效，未启动应用");
            }
            let dispatched = self.driver.perform(action, None);
            let after = self.driver.observe();
            if dispatched.is_err()
                || self.driver.input_epoch() != self.owner_epoch
                || !self.driver.monitor_healthy()
                || !after.as_ref().is_ok_and(|o| o.bundle_id == *bundle_id)
            {
                self.pause();
                return self.result(
                    "unknown",
                    "应用启动已请求，尚未核对到目标前台窗口；禁止重复启动",
                );
            }
            let mut result = self.result("verified", "已核对启动应用的前台窗口身份");
            result.evidence = Some(format!("前台应用 bundle ID: {bundle_id}"));
            result.observation = self.observe(task, now).ok();
            return result;
        }
        let Some((version, reference)) = action.target() else {
            return self.result("failure", "动作缺少观察目标");
        };
        let Some(saved) = self.observations.remove(task) else {
            return self.result("needs_user", "请先重新观察目标窗口");
        };
        if saved.version != version || now.saturating_sub(saved.at) > OBSERVATION_TTL_MS {
            return self.result("needs_user", "观察引用已过期，请重新观察");
        }
        if self.driver.input_epoch() != saved.input_epoch {
            self.pause();
            return self.result("needs_user", "检测到人工接管，已让出桌面；请明确恢复");
        }
        let prefix = format!("{version}:");
        let index = reference
            .strip_prefix(&prefix)
            .and_then(|s| s.parse::<usize>().ok());
        let Some(target) = index.and_then(|index| saved.native.elements.get(index)) else {
            return self.result("failure", "目标引用不属于本次观察");
        };
        if target.sensitive || !target.enabled {
            return self.result("needs_user", "敏感或不可用的目标不能自动操作");
        }
        let Ok(fresh) = self.driver.observe() else {
            return self.result("needs_user", "目标无法重新核对");
        };
        if !same_window(&saved.native, &fresh) {
            return self.result("needs_user", "前台应用或窗口已改变，请重新观察");
        }
        let targets: Vec<_> = fresh
            .elements
            .iter()
            .filter(|candidate| same_element(target, candidate))
            .collect();
        if targets.len() != 1 {
            return self.result("needs_user", "目标已变化或存在歧义，请重新观察");
        }
        let target = targets[0];
        let local_edit = matches!(action, DesktopAction::Type { .. })
            && fresh.bundle_id == "com.apple.TextEdit"
            && target.role == "AXTextArea"
            && target.actions.iter().any(|a| a == "set_value");
        if !local_edit && !authorization.allow_external {
            return self.result(
                "needs_user",
                "无法证明为安全本地编辑，需要确认准确目标和操作",
            );
        }
        let supported = match action {
            DesktopAction::Type { text, .. } => {
                text.chars().count() <= 4000 && target.actions.iter().any(|a| a == "set_value")
            }
            DesktopAction::Click { .. } => target.actions.iter().any(|a| a == "press"),
            DesktopAction::Key { .. } => target.focused,
            DesktopAction::Scroll { .. } => target.actions.iter().any(|a| a == "scroll"),
            DesktopAction::FocusWindow { .. } => {
                target.role == "AXWindow" && target.actions.iter().any(|a| a == "focus")
            }
            _ => false,
        };
        if !supported {
            return self.result("needs_user", "该原子动作尚未具备可验证的原生实现，未执行");
        }
        // 此检查紧邻系统调用；回调不获取服务锁，人工输入即使在观察期间发生也能拦截。
        if self.driver.input_epoch() != saved.input_epoch || !self.driver.monitor_healthy() {
            self.pause();
            return self.result("needs_user", "人工接管或监听失效，未派发动作");
        }
        let dispatch = self.driver.perform(action, Some(target.handle));
        let after = self.driver.observe();
        if self.driver.input_epoch() != saved.input_epoch || !self.driver.monitor_healthy() {
            self.pause();
            return self.result(
                "unknown",
                "动作期间发生人工接管；已停止后续动作，结果需核对",
            );
        }
        if dispatch.is_err() {
            self.pause();
            return self.result("unknown", "系统可能已接收动作，结果未知；禁止自动重试");
        }
        let verified = match (action, &after) {
            (DesktopAction::Type { text, .. }, Ok(after)) if same_window(&fresh, after) => {
                let matches: Vec<_> = after
                    .elements
                    .iter()
                    .filter(|e| same_target(target, e))
                    .collect();
                matches.len() == 1
                    && !matches[0].value_truncated
                    && matches[0].value.as_deref() == Some(text.as_str())
            }
            (DesktopAction::FocusWindow { .. }, Ok(after)) => same_window(&fresh, after),
            (DesktopAction::Click { .. }, Ok(after))
                if same_window(&fresh, after)
                    && target.role == "AXCheckBox"
                    && !target.value_truncated =>
            {
                let matches: Vec<_> = after
                    .elements
                    .iter()
                    .filter(|e| same_target(target, e))
                    .collect();
                matches.len() == 1
                    && !matches[0].value_truncated
                    && matches!(
                        (target.value.as_deref(), matches[0].value.as_deref()),
                        (Some("0"), Some("1")) | (Some("1"), Some("0"))
                    )
            }
            _ => false,
        };
        if !verified {
            self.pause();
            return self.result(
                "unknown",
                "动作已派发，但没有足够证据证明目标结果；禁止自动重试",
            );
        }
        let mut result = self.result("verified", "Host 已核对原子动作的目标状态");
        result.evidence = Some(
            match action {
                DesktopAction::Type { .. } => "AX 控件完整值与本次输入完全一致",
                DesktopAction::FocusWindow { .. } => "前台窗口身份与目标窗口一致",
                _ => "AX 复选框状态按预期翻转；不代表业务操作成功",
            }
            .into(),
        );
        // 消耗旧观察；动作后的新观察绑定当前输入代次。
        if let Ok(observation) = self.observe(task, now) {
            result.observation = Some(observation);
        }
        result
    }

    fn observe(
        &mut self,
        task: &str,
        now: u64,
    ) -> Result<PayloadDesktopObservation, ObservationError> {
        let epoch = self.driver.input_epoch();
        let native = self.driver.observe()?;
        if epoch != self.driver.input_epoch() {
            self.pause();
            return Err(ObservationError::TargetChanged);
        }
        self.sequence += 1;
        let version = format!("{}-{}-{}", self.boot_id, self.generation, self.sequence);
        let observation = PayloadDesktopObservation {
            version: version.clone(),
            observed_at_ms: now,
            bundle_id: native.bundle_id.clone(),
            process_id: native.process_id.into(),
            window_id: native.window_id.clone(),
            title: native.title.clone(),
            elements: native
                .elements
                .iter()
                .enumerate()
                .map(|(index, e)| PayloadDesktopElement {
                    reference: format!("{version}:{index}"),
                    role: e.role.clone(),
                    label: if e.sensitive {
                        String::new()
                    } else {
                        e.label.clone()
                    },
                    value: if e.sensitive { None } else { e.value.clone() },
                    value_truncated: e.value_truncated,
                    focused: e.focused,
                    enabled: e.enabled,
                    sensitive: e.sensitive,
                    actions: if e.sensitive {
                        vec![]
                    } else {
                        e.actions.clone()
                    },
                    bounds: e.bounds.clone(),
                    depth: e.depth,
                })
                .collect(),
            truncated: native.truncated,
        };
        self.observations.insert(
            task.into(),
            Observation {
                version,
                at: now,
                input_epoch: epoch,
                native,
            },
        );
        Ok(observation)
    }
}

fn same_window(a: &NativeObservation, b: &NativeObservation) -> bool {
    a.bundle_id == b.bundle_id && a.process_id == b.process_id && a.window_id == b.window_id
}
fn same_target(a: &NativeElement, b: &NativeElement) -> bool {
    a.identity == b.identity
        && a.role == b.role
        && a.label == b.label
        && a.depth == b.depth
        && !b.sensitive
        && b.enabled
        && serde_json::to_value(&a.bounds).ok() == serde_json::to_value(&b.bounds).ok()
}
fn same_element(a: &NativeElement, b: &NativeElement) -> bool {
    same_target(a, b)
        && a.value == b.value
        && a.value_truncated == b.value_truncated
        && a.focused == b.focused
        && a.actions == b.actions
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
