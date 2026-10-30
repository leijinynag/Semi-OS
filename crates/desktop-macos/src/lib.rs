//! 原生句柄只在本 crate 内生存。Host 使用临时索引，不向 Node 暴露 AX 指针。
use semi_os_protocol::messages::{PayloadDesktopBounds, PayloadDesktopPermissions};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
pub use native::MacDesktop;

pub const CRATE_NAME: &str = "desktop-macos";

/// 可程序化请求的 TCC 权限闭集。
///
/// 为什么是闭集而不是自由字符串：授权请求会直接触发系统级弹窗并写入 TCC
/// 记录，只有明确枚举过的权限才允许走到 FFI。未知名字一律拒绝，避免上层
/// 拼接出脚本、别名或大小写变体绕过审核。麦克风也在闭集中，便于用户
/// 主动请求后在系统设置中找到应用；没有列出的能力不提供请求入口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Accessibility,
    InputMonitoring,
    ScreenRecording,
    Microphone,
}

impl PermissionKind {
    /// 与 IPC/JSON 名字严格一致；不接受别名、大小写变体或前后空白。
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "accessibility" => Some(Self::Accessibility),
            "inputMonitoring" => Some(Self::InputMonitoring),
            "screenRecording" => Some(Self::ScreenRecording),
            // 麦克风必须可请求：TCC 只把真正发起过请求的应用列进系统设置，
            // 没有这个入口时用户会卡在“列表里找不到应用”。
            "microphone" => Some(Self::Microphone),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::InputMonitoring => "inputMonitoring",
            Self::ScreenRecording => "screenRecording",
            Self::Microphone => "microphone",
        }
    }
}

/// 授权请求结果。
///
/// `Requested` 表示“已向系统发起请求，但当前仍未授权”。macOS 不暴露
/// “用户点了拒绝”还是“系统抑制了弹窗”，所以这里不臆造第三种状态；
/// 界面需要如实提示用户去系统设置手动勾选，而不是代替系统宣布用户拒绝。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionRequestOutcome {
    Granted,
    Requested,
}

impl PermissionRequestOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Requested => "requested",
        }
    }
}

/// 触发系统授权请求。
///
/// 必须只由用户显式动作调用。启动、定时刷新和错误重试路径都不得走到这里，
/// 否则应用会在用户没有预期的时候弹窗。查询权限请用 `MacDesktop::permissions`。
#[cfg(target_os = "macos")]
pub fn request_permission(kind: PermissionKind) -> Result<PermissionRequestOutcome, String> {
    native::request_permission(kind)
}

#[cfg(not(target_os = "macos"))]
pub fn request_permission(_kind: PermissionKind) -> Result<PermissionRequestOutcome, String> {
    Err("原生桌面授权请求仅支持 macOS".into())
}

#[derive(Debug, Clone)]
pub struct NativeElement {
    pub handle: usize,
    pub identity: u64,
    pub role: String,
    pub label: String,
    pub value: Option<String>,
    pub value_truncated: bool,
    pub focused: bool,
    pub enabled: bool,
    pub sensitive: bool,
    pub actions: Vec<String>,
    pub bounds: Option<PayloadDesktopBounds>,
    pub depth: u64,
}

#[derive(Debug, Clone)]
pub struct NativeObservation {
    pub bundle_id: String,
    pub process_id: u32,
    pub window_id: String,
    pub title: String,
    pub elements: Vec<NativeElement>,
    pub truncated: bool,
}

/// 观察失败不应全部归因为权限；闭集错误不携带窗口正文或系统原始数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationError {
    PermissionDenied,
    NoApplication,
    NoWindow,
    ApplicationUnavailable,
    AccessibilityUnavailable,
    AccessibilityMessagingFailed,
    TargetChanged,
}

impl ObservationError {
    pub fn ui_message(self) -> &'static str {
        match self {
            Self::PermissionDenied => "需要辅助功能权限；请授权当前运行的 Semi-OS 应用",
            Self::NoApplication => "未找到前台应用；请切换到有窗口的应用后重新观察",
            Self::NoWindow => "前台应用没有可观察窗口；请打开目标应用的窗口后重新观察",
            Self::ApplicationUnavailable => "前台应用已退出或无法确定身份；请重新观察",
            Self::AccessibilityUnavailable => {
                "系统辅助功能接口当前不可用；请核对当前运行应用的授权并重新观察"
            }
            Self::AccessibilityMessagingFailed => {
                "前台应用的辅助功能接口未响应或通信失败；请等待目标应用就绪后重新观察"
            }
            Self::TargetChanged => "观察期间检测到人工输入或前台应用切换；请重新观察",
        }
    }
}

/// 单次动作协议不接受脚本、宏、剪贴板或模型声称的安全等级。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopAction {
    Observe,
    Click {
        version: String,
        reference: String,
    },
    Type {
        version: String,
        reference: String,
        text: String,
    },
    Key {
        version: String,
        reference: String,
        key: String,
        modifiers: Vec<String>,
    },
    Scroll {
        version: String,
        reference: String,
        direction: String,
        amount: u8,
    },
    FocusWindow {
        version: String,
        reference: String,
    },
    LaunchApp {
        #[serde(rename = "bundleId")]
        bundle_id: String,
    },
}

impl DesktopAction {
    pub fn target(&self) -> Option<(&str, &str)> {
        match self {
            Self::Observe | Self::LaunchApp { .. } => None,
            Self::Click { version, reference }
            | Self::Type {
                version, reference, ..
            }
            | Self::Key {
                version, reference, ..
            }
            | Self::Scroll {
                version, reference, ..
            }
            | Self::FocusWindow { version, reference } => Some((version, reference)),
        }
    }
}

/// 实际动作与测试驱动共享接口；验证仍由 Host 读回观察，不信任驱动成功布尔值。
pub trait DesktopDriver: Send {
    fn permissions(&mut self, now: u64) -> PayloadDesktopPermissions;
    fn observe(&mut self) -> Result<NativeObservation, ObservationError>;
    fn input_epoch(&self) -> u64;
    fn monitor_healthy(&self) -> bool;
    /// 仅由明确的用户恢复/重新检查触发；Host 必须先废弃旧租约。
    fn recover_input_monitor(&mut self) {}
    fn perform(&mut self, action: &DesktopAction, handle: Option<usize>) -> Result<(), String>;
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    /// 授权名字是能力边界，必须拒绝任何未列出的输入。
    #[test]
    fn parse_accepts_only_the_closed_set() {
        assert_eq!(
            PermissionKind::parse("accessibility"),
            Some(PermissionKind::Accessibility)
        );
        assert_eq!(
            PermissionKind::parse("inputMonitoring"),
            Some(PermissionKind::InputMonitoring)
        );
        assert_eq!(
            PermissionKind::parse("screenRecording"),
            Some(PermissionKind::ScreenRecording)
        );
        assert_eq!(
            PermissionKind::parse("microphone"),
            Some(PermissionKind::Microphone)
        );
        for rejected in [
            "",
            "Microphone",
            "microphone ",
            "camera",
            "accessibility ",
            " accessibility",
            "accessibility;open",
            "scripts",
            "shell",
        ] {
            assert_eq!(PermissionKind::parse(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn names_round_trip() {
        for kind in [
            PermissionKind::Accessibility,
            PermissionKind::InputMonitoring,
            PermissionKind::ScreenRecording,
            PermissionKind::Microphone,
        ] {
            assert_eq!(PermissionKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(PermissionRequestOutcome::Granted.as_str(), "granted");
        assert_eq!(PermissionRequestOutcome::Requested.as_str(), "requested");
    }
}
