use serde::Serialize;

use crate::error::{HostError, HostResult};

/// Host 进程自身的生命周期，不与具体任务或 Agent Worker 状态混用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostPhase {
    Starting,
    Ready,
    ShuttingDown,
    Stopped,
}

/// 供 Tauri 入口和无界面测试共用的生命周期路由命令。
///
/// 路由只负责校验并推进 Host 自身状态，不触碰 Worker、窗口或 SQLite。
/// 这些副作用仍由应用组装层执行，避免把桌面壳依赖倒灌进可测试核心。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleCommand {
    Read,
    MarkReady { shortcut_registered: bool },
    BeginShutdown,
    MarkStopped,
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

/// 执行一个纯生命周期命令并返回最新快照。
pub fn route_lifecycle(
    lifecycle: &mut HostLifecycle,
    command: LifecycleCommand,
) -> HostResult<HostLifecycleSnapshot> {
    match command {
        LifecycleCommand::Read => return Ok(lifecycle.snapshot()),
        LifecycleCommand::MarkReady {
            shortcut_registered,
        } => {
            if lifecycle.snapshot.phase != HostPhase::Starting {
                return Err(HostError::InvalidLifecycleTransition {
                    from: lifecycle.snapshot.phase,
                    to: HostPhase::Ready,
                });
            }
            lifecycle.mark_ready(shortcut_registered);
        }
        LifecycleCommand::BeginShutdown => {
            if lifecycle.snapshot.phase == HostPhase::Stopped {
                return Err(HostError::InvalidLifecycleTransition {
                    from: HostPhase::Stopped,
                    to: HostPhase::ShuttingDown,
                });
            }
            lifecycle.mark_shutting_down();
        }
        LifecycleCommand::MarkStopped => {
            if lifecycle.snapshot.phase != HostPhase::ShuttingDown {
                return Err(HostError::InvalidLifecycleTransition {
                    from: lifecycle.snapshot.phase,
                    to: HostPhase::Stopped,
                });
            }
            lifecycle.mark_stopped();
        }
    }
    Ok(lifecycle.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advances_host_lifecycle_without_mixing_worker_state() {
        let mut lifecycle = HostLifecycle::default();
        assert_eq!(
            route_lifecycle(&mut lifecycle, LifecycleCommand::Read)
                .expect("read should succeed")
                .phase,
            HostPhase::Starting
        );

        route_lifecycle(
            &mut lifecycle,
            LifecycleCommand::MarkReady {
                shortcut_registered: true,
            },
        )
        .expect("ready should succeed");
        assert_eq!(
            lifecycle.snapshot(),
            HostLifecycleSnapshot {
                phase: HostPhase::Ready,
                shortcut_registered: true,
            }
        );

        route_lifecycle(&mut lifecycle, LifecycleCommand::BeginShutdown)
            .expect("shutdown should begin");
        assert_eq!(lifecycle.snapshot().phase, HostPhase::ShuttingDown);
        route_lifecycle(&mut lifecycle, LifecycleCommand::MarkStopped)
            .expect("stop should succeed");
        assert_eq!(lifecycle.snapshot().phase, HostPhase::Stopped);
    }

    #[test]
    fn rejects_ready_after_host_has_started() {
        let mut lifecycle = HostLifecycle::default();
        route_lifecycle(
            &mut lifecycle,
            LifecycleCommand::MarkReady {
                shortcut_registered: false,
            },
        )
        .expect("first ready should succeed");

        let error = route_lifecycle(
            &mut lifecycle,
            LifecycleCommand::MarkReady {
                shortcut_registered: true,
            },
        )
        .expect_err("second ready should be rejected");
        assert!(matches!(
            error,
            HostError::InvalidLifecycleTransition { .. }
        ));
    }
}
