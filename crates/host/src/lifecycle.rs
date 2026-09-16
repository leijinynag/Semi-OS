use serde::Serialize;

/// Host 进程自身的生命周期，不与具体任务或 Agent Worker 状态混用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostPhase {
    Starting,
    Ready,
    ShuttingDown,
    Stopped,
}

/// 提供给 Tauri command 和 UI 的只读生命周期快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLifecycleSnapshot {
    pub phase: HostPhase,
    pub shortcut_registered: bool,
}

/// Host 生命周期状态机。
///
/// 状态转换由 Rust Host 单向推进，React 只能读取快照，不能自行推断 Host
/// 是否已经完成快捷键、Worker 和诊断设施的初始化。
#[derive(Debug)]
pub struct HostLifecycle {
    snapshot: HostLifecycleSnapshot,
}

impl Default for HostLifecycle {
    fn default() -> Self {
        Self {
            snapshot: HostLifecycleSnapshot {
                phase: HostPhase::Starting,
                shortcut_registered: false,
            },
        }
    }
}

impl HostLifecycle {
    pub fn snapshot(&self) -> HostLifecycleSnapshot {
        self.snapshot
    }

    pub fn mark_ready(&mut self, shortcut_registered: bool) {
        self.snapshot = HostLifecycleSnapshot {
            phase: HostPhase::Ready,
            shortcut_registered,
        };
    }

    pub fn mark_shutting_down(&mut self) {
        if self.snapshot.phase != HostPhase::Stopped {
            self.snapshot.phase = HostPhase::ShuttingDown;
        }
    }

    pub fn mark_stopped(&mut self) {
        self.snapshot.phase = HostPhase::Stopped;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advances_host_lifecycle_without_mixing_worker_state() {
        let mut lifecycle = HostLifecycle::default();
        assert_eq!(lifecycle.snapshot().phase, HostPhase::Starting);

        lifecycle.mark_ready(true);
        assert_eq!(
            lifecycle.snapshot(),
            HostLifecycleSnapshot {
                phase: HostPhase::Ready,
                shortcut_registered: true,
            }
        );

        lifecycle.mark_shutting_down();
        assert_eq!(lifecycle.snapshot().phase, HostPhase::ShuttingDown);
        lifecycle.mark_stopped();
        assert_eq!(lifecycle.snapshot().phase, HostPhase::Stopped);
    }
}
