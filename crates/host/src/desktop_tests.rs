use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

struct Fixture {
    epoch: Arc<AtomicU64>,
    snapshot: NativeObservation,
    monitor: bool,
    allowed: bool,
    screen: bool,
    applied: usize,
    fail_after_apply: bool,
    takeover_on_apply: bool,
    observation_error: Option<ObservationError>,
}
impl Fixture {
    fn new() -> Self {
        Self {
            epoch: Arc::new(AtomicU64::new(0)),
            monitor: true,
            allowed: true,
            screen: false,
            applied: 0,
            fail_after_apply: false,
            takeover_on_apply: false,
            observation_error: None,
            snapshot: NativeObservation {
                bundle_id: "com.apple.TextEdit".into(),
                process_id: 42,
                window_id: "window-1".into(),
                title: "Synthetic document".into(),
                truncated: false,
                elements: vec![NativeElement {
                    handle: 0,
                    identity: 1,
                    value_truncated: false,
                    focused: true,
                    role: "AXTextArea".into(),
                    label: "Document".into(),
                    value: Some(String::new()),
                    enabled: true,
                    sensitive: false,
                    actions: vec!["set_value".into()],
                    depth: 1,
                    bounds: Some(semi_os_protocol::messages::PayloadDesktopBounds {
                        x: -500.0,
                        y: 30.0,
                        width: 300.0,
                        height: 200.0,
                    }),
                }],
            },
        }
    }
}
impl DesktopDriver for Fixture {
    fn permissions(&mut self, now: u64) -> PayloadDesktopPermissions {
        PayloadDesktopPermissions {
            accessibility: if self.allowed { "granted" } else { "denied" }.into(),
            microphone: "denied".into(),
            screen_recording: if self.screen { "granted" } else { "denied" }.into(),
            input_monitoring: "granted".into(),
            takeover_detection: self.monitor,
            visual_fallback: semi_os_protocol::messages::PayloadDesktopVisualCapability {
                status: "unavailable".into(),
                reason: "fixture does not provide visual fallback".into(),
            },
            checked_at_ms: now,
        }
    }
    fn observe(&mut self) -> Result<NativeObservation, ObservationError> {
        if let Some(error) = self.observation_error {
            return Err(error);
        }
        Ok(self.snapshot.clone())
    }
    fn input_epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    fn monitor_healthy(&self) -> bool {
        self.monitor
    }
    fn recover_input_monitor(&mut self) {
        self.monitor = true;
    }
    fn perform(&mut self, action: &DesktopAction, _: Option<usize>) -> Result<(), String> {
        self.applied += 1;
        if let DesktopAction::Type { text, .. } = action {
            self.snapshot.elements[0].value = Some(text.clone());
        }
        if self.takeover_on_apply {
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
        if self.fail_after_apply {
            Err("transport interrupted after dispatch".into())
        } else {
            Ok(())
        }
    }
}
fn ready() -> DesktopService<Fixture> {
    let mut service = DesktopService::new(Fixture::new(), "boot-1".into());
    service.acquire("task", true).unwrap();
    service
}
fn input(service: &mut DesktopService<Fixture>) -> DesktopAction {
    let observation = service
        .execute("task", &DesktopAction::Observe, None, 10)
        .observation
        .unwrap();
    DesktopAction::Type {
        version: observation.version,
        reference: observation.elements[0].reference.clone(),
        text: "你好 Semi-OS".into(),
    }
}

#[test]
fn semantic_edit_readback_does_not_require_microphone_or_screenshot() {
    let mut service = ready();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    let result = service.execute("task", &action, Some(&authorization), 11);
    assert_eq!(result.status, "verified");
    assert_eq!(service.driver.applied, 1);
    assert_eq!(
        result.observation.unwrap().elements[0].value.as_deref(),
        Some("你好 Semi-OS")
    );
}

#[test]
fn denied_permission_or_unavailable_takeover_monitor_never_dispatches() {
    for permission in [true, false] {
        let mut service = ready();
        let action = input(&mut service);
        let authorization = service.authorize_action("task", &action, false).unwrap();
        if permission {
            service.driver.allowed = false;
        } else {
            service.driver.monitor = false;
        }
        assert_eq!(
            service
                .execute("task", &action, Some(&authorization), 11)
                .status,
            "needs_user"
        );
        assert_eq!(service.driver.applied, 0);
    }
}

#[test]
fn human_takeover_requires_explicit_resume_and_new_observation() {
    let mut service = ready();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    service.driver.epoch.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 11)
            .status,
        "needs_user"
    );
    assert!(service.acquire("task", true).is_err());
    service.resume_by_user();
    service.acquire("task", true).unwrap();
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 12)
            .status,
        "needs_user"
    );
    assert_eq!(service.driver.applied, 0);
}

#[test]
fn duplicate_ambiguous_changed_or_expired_target_requires_reobserve() {
    for scenario in 0..4 {
        let mut service = ready();
        let action = input(&mut service);
        let authorization = service.authorize_action("task", &action, false).unwrap();
        match scenario {
            0 => service
                .driver
                .snapshot
                .elements
                .push(service.driver.snapshot.elements[0].clone()),
            1 => service.driver.snapshot.window_id = "different-window".into(),
            2 => service.driver.snapshot.elements[0].value = Some("User edit".into()),
            _ => (),
        }
        let now = if scenario == 3 { 20_000 } else { 11 };
        assert_eq!(
            service
                .execute("task", &action, Some(&authorization), now)
                .status,
            "needs_user"
        );
        assert_eq!(service.driver.applied, 0);
    }
}

#[test]
fn possibly_applied_or_takeover_during_dispatch_stays_unknown() {
    for takeover in [true, false] {
        let mut service = ready();
        service.driver.takeover_on_apply = takeover;
        service.driver.fail_after_apply = !takeover;
        let action = input(&mut service);
        let authorization = service.authorize_action("task", &action, false).unwrap();
        assert_eq!(
            service
                .execute("task", &action, Some(&authorization), 11)
                .status,
            "unknown"
        );
        assert_eq!(
            service
                .execute("task", &action, Some(&authorization), 12)
                .status,
            "needs_user"
        );
        assert_eq!(service.driver.applied, 1);
    }
}

#[test]
fn sensitive_target_and_unapproved_external_edit_are_blocked() {
    let mut service = ready();
    service.driver.snapshot.elements[0].sensitive = true;
    service.driver.snapshot.elements[0].value = Some("never exported".into());
    let observation = service
        .execute("task", &DesktopAction::Observe, None, 10)
        .observation
        .unwrap();
    assert!(observation.elements[0].value.is_none());
    assert!(observation.elements[0].actions.is_empty());
    service.driver.snapshot.elements[0].sensitive = false;
    service.driver.snapshot.bundle_id = "com.example.messenger".into();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 11)
            .status,
        "needs_user"
    );
    assert_eq!(service.driver.applied, 0);
}

#[test]
fn restarting_service_invalidates_observation_and_authorization() {
    let mut old = ready();
    let action = input(&mut old);
    let authorization = old.authorize_action("task", &action, false).unwrap();
    let mut restored = DesktopService::new(Fixture::new(), "boot-2".into());
    assert_eq!(
        restored
            .execute("task", &action, Some(&authorization), 11)
            .status,
        "needs_user"
    );
    assert_eq!(restored.driver.applied, 0);
}

#[test]
fn matching_appearance_cannot_substitute_a_different_native_object() {
    let mut service = ready();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    service.driver.snapshot.elements[0].identity = 99;
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 11)
            .status,
        "needs_user"
    );
    assert_eq!(service.driver.applied, 0);
}

#[test]
fn truncated_readback_is_not_verified_and_changed_authorization_is_rejected() {
    let mut service = ready();
    service.driver.snapshot.elements[0].value_truncated = true;
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 11)
            .status,
        "unknown"
    );
    assert_eq!(service.driver.applied, 1);
    let mut service = ready();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    let mut changed = action.clone();
    if let DesktopAction::Type { text, .. } = &mut changed {
        *text = "different".into();
    }
    assert_eq!(
        service
            .execute("task", &changed, Some(&authorization), 11)
            .status,
        "needs_user"
    );
    assert_eq!(service.driver.applied, 0);
}

#[test]
fn registered_keyboard_and_scroll_actions_never_treat_dispatch_as_success() {
    for scroll in [true, false] {
        let mut service = ready();
        service.driver.snapshot.elements[0]
            .actions
            .push("scroll".into());
        let observed = service
            .execute("task", &DesktopAction::Observe, None, 10)
            .observation
            .unwrap();
        let reference = observed.elements[0].reference.clone();
        let version = observed.version;
        let action = if scroll {
            DesktopAction::Scroll {
                version,
                reference,
                direction: "down".into(),
                amount: 1,
            }
        } else {
            DesktopAction::Key {
                version,
                reference,
                key: "return".into(),
                modifiers: vec![],
            }
        };
        let authorization = service.authorize_action("task", &action, true).unwrap();
        assert_eq!(
            service
                .execute("task", &action, Some(&authorization), 11)
                .status,
            "unknown"
        );
        assert_eq!(service.driver.applied, 1);
    }
}

#[test]
fn the_first_permission_read_keeps_a_fresh_lease() {
    // 首次读取没有历史指纹可比，不能因此误废用户刚建立的租约。
    let mut service = ready();
    let generation = service.lease_generation();
    assert_eq!(service.permissions(9).accessibility, "granted");
    assert_eq!(service.owner(), Some("task"));
    assert_eq!(service.lease_generation(), generation);
}

#[test]
fn a_permission_change_invalidates_the_approval_issued_before_it() {
    // 屏幕录制授权变化不影响可见性，但代表能力边界已变：授权前拿到的批准
    // 与引用必须作废，不能把旧引用带进新权限继续派发。
    let mut service = ready();
    service.permissions(9);
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, false).unwrap();
    let generation = service.lease_generation();

    service.driver.screen = true;
    assert_eq!(service.permissions(11).screen_recording, "granted");
    assert_eq!(service.owner(), None);
    assert!(service.lease_generation() > generation);

    let result = service.execute("task", &action, Some(&authorization), 12);
    assert_eq!(result.status, "needs_user");
    assert_eq!(service.driver.applied, 0);
}

#[test]
fn accepting_a_permission_request_discards_the_previous_lease() {
    let mut service = DesktopService::new(Fixture::new(), "boot-1".into());
    service.driver.allowed = false;
    assert_eq!(service.permissions(9).accessibility, "denied");
    service.acquire("task", true).unwrap();
    let generation = service.lease_generation();

    service.driver.allowed = true;
    let snapshot = service.apply_permission_change(true, 10);
    assert_eq!(snapshot.accessibility, "granted");
    assert_eq!(service.owner(), None);
    assert!(service.lease_generation() > generation);
    assert!(service
        .authorize_action("task", &DesktopAction::Observe, false)
        .is_err());
}

#[test]
fn a_pending_permission_request_keeps_the_current_lease() {
    // 用户还没在系统弹窗里决定时不得影响正在进行的任务。
    let mut service = ready();
    let generation = service.lease_generation();
    assert_eq!(
        service.apply_permission_change(false, 12).accessibility,
        "granted"
    );
    assert_eq!(service.owner(), Some("task"));
    assert_eq!(service.lease_generation(), generation);
}

#[test]
fn observation_failure_is_not_misreported_as_a_permission_denial() {
    for error in [
        ObservationError::NoWindow,
        ObservationError::NoApplication,
        ObservationError::ApplicationUnavailable,
        ObservationError::AccessibilityUnavailable,
        ObservationError::AccessibilityMessagingFailed,
        ObservationError::TargetChanged,
    ] {
        let mut service = ready();
        service.driver.observation_error = Some(error);
        let result = service.execute("task", &DesktopAction::Observe, None, 10);
        assert_eq!(result.status, "needs_user");
        assert_eq!(result.summary, error.ui_message());
        assert_eq!(service.driver.applied, 0);
    }
}

#[test]
fn explicit_monitor_recovery_discards_old_approvals_and_references() {
    let mut service = ready();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, true).unwrap();
    service.driver.monitor = false;
    // 普通查询不能重建或悄悄恢复。
    assert!(!service.permissions(11).takeover_detection);
    let generation = service.lease_generation();
    assert!(service.recheck_permissions_by_user(12).takeover_detection);
    assert!(service.lease_generation() > generation);
    assert_eq!(service.owner(), None);
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 13)
            .status,
        "needs_user"
    );
    assert_eq!(service.driver.applied, 0);
    service.acquire("task", true).unwrap();
    let action = input(&mut service);
    let authorization = service.authorize_action("task", &action, true).unwrap();
    assert_eq!(
        service
            .execute("task", &action, Some(&authorization), 14)
            .status,
        "verified"
    );
}

#[test]
fn rechecking_permissions_does_not_resume_a_paused_task() {
    let mut service = ready();
    service.pause();
    service.driver.monitor = false;
    assert!(service.recheck_permissions_by_user(11).takeover_detection);
    assert!(service.acquire("task", true).is_err());
    service.resume_by_user();
    assert!(service.acquire("task", true).is_ok());
}
