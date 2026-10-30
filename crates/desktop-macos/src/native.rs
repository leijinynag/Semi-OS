//! Apple FFI 集中在此；Copy/Create 对象由 Owned 释放，借用对象不逃出调用栈。
use crate::{
    DesktopAction, DesktopDriver, NativeElement, NativeObservation, ObservationError,
    PermissionKind, PermissionRequestOutcome,
};
use objc2::{msg_send, runtime::AnyClass};
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use semi_os_protocol::messages::{
    PayloadDesktopBounds, PayloadDesktopPermissions, PayloadDesktopVisualCapability,
};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_void},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
};

type Cf = *const c_void;
const UTF8: u32 = 0x08000100;
const EVENT_MARKER: i64 = 0x53454d494f53;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Default)]
struct Size {
    width: f64,
    height: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    // 与 AXIsProcessTrusted 的区别：带 prompt 选项会把应用登记进 TCC 并弹窗。
    fn AXIsProcessTrustedWithOptions(options: Cf) -> bool;
    static kAXTrustedCheckOptionPrompt: Cf;
    // 下面两个请求函数会阻塞到用户响应，只能在 spawn_blocking 里调用。
    fn CGRequestListenEventAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn AXUIElementCreateSystemWide() -> Cf;
    fn AXUIElementCreateApplication(pid: i32) -> Cf;
    fn AXUIElementCopyAttributeValue(element: Cf, attribute: Cf, value: *mut Cf) -> i32;
    fn AXUIElementGetPid(element: Cf, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Cf, timeout: f32) -> i32;
    fn AXUIElementIsAttributeSettable(element: Cf, attribute: Cf, value: *mut bool) -> i32;
    fn AXUIElementCopyActionNames(element: Cf, names: *mut Cf) -> i32;
    fn AXUIElementPerformAction(element: Cf, action: Cf) -> i32;
    fn AXUIElementSetAttributeValue(element: Cf, attribute: Cf, value: Cf) -> i32;
    fn AXValueGetValue(value: Cf, kind: u32, output: *mut c_void) -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: unsafe extern "C" fn(Cf, u32, Cf, *mut c_void) -> Cf,
        info: *mut c_void,
    ) -> Cf;
    fn CGEventTapIsEnabled(tap: Cf) -> bool;
    fn CGEventGetIntegerValueField(event: Cf, field: u32) -> i64;
    fn CGEventCreateKeyboardEvent(source: Cf, key: u16, down: bool) -> Cf;
    fn CGEventCreateScrollWheelEvent(source: Cf, units: u32, wheels: u32, wheel1: i32, ...) -> Cf;
    fn CGEventSetIntegerValueField(event: Cf, field: u32, value: i64);
    fn CGEventSetFlags(event: Cf, flags: u64);
    fn CGEventSetLocation(event: Cf, point: Point);
    fn CGEventPost(tap: u32, event: Cf);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFRetain(value: Cf) -> Cf;
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFEqual(a: Cf, b: Cf) -> bool;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetLength(value: Cf) -> isize;
    fn CFArrayGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        allocator: Cf,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: bool,
    ) -> Cf;
    fn CFStringGetCString(value: Cf, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFArrayGetCount(value: Cf) -> isize;
    fn CFArrayGetValueAtIndex(value: Cf, index: isize) -> Cf;
    fn CFBooleanGetValue(value: Cf) -> bool;
    // 仅测试使用：用于在“不调用授权 API”的前提下读回选项字典。生产路径不读字典，
    // 所以这里用 cfg(test) 避免正常构建出现 dead_code 警告。
    #[cfg(test)]
    fn CFDictionaryGetCount(dict: Cf) -> isize;
    #[cfg(test)]
    fn CFDictionaryGetValueIfPresent(dict: Cf, key: Cf, value: *mut Cf) -> bool;
    fn CFBooleanGetTypeID() -> usize;
    fn CFDictionaryCreate(
        allocator: Cf,
        keys: *const Cf,
        values: *const Cf,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> Cf;
    static kCFBooleanTrue: Cf;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFMachPortCreateRunLoopSource(allocator: Cf, port: Cf, order: isize) -> Cf;
    fn CFRunLoopGetCurrent() -> Cf;
    fn CFRunLoopAddSource(run_loop: Cf, source: Cf, mode: Cf);
    fn CFRunLoopRunInMode(mode: Cf, seconds: f64, return_after_source: bool) -> i32;
    static kCFRunLoopCommonModes: Cf;
    static kCFRunLoopDefaultMode: Cf;
}
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

/// 麦克风授权状态（AVAuthorizationStatus）：3 已授权，2 拒绝，1 受限，0 未决定。
const AV_AUTHORIZATION_AUTHORIZED: isize = 3;

/// 麦克风授权是异步回调，必须由调用方阻塞等待后拿到确定结果。
///
/// 超时也不能当成「已授权」：TCC 弹窗可能一直没人点，把未决当成授权会让
/// 后续录音静默失败。超时后仍按 `Requested` 返回，让界面继续显示待授权。
fn request_microphone() -> bool {
    let status = microphone_status();
    if status == AV_AUTHORIZATION_AUTHORIZED {
        return true;
    }
    let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
        return false;
    };
    // 与其他权限保持一致：用四字符码构造媒体类型，避免依赖导出的常量符号。
    let media = NSString::from_str("soun");
    let (sender, receiver) = std::sync::mpsc::channel();
    let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
        // 接收端可能因超时先被丢弃，发送失败是预期分支。
        let _ = sender.send(granted.as_bool());
    });
    unsafe {
        let _: () =
            msg_send![class, requestAccessForMediaType: &*media, completionHandler: &*handler];
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(120))
        .unwrap_or(false)
}

fn microphone_status() -> isize {
    let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
        return -1;
    };
    let media = NSString::from_str("soun");
    unsafe { msg_send![class, authorizationStatusForMediaType: &*media] }
}

struct Owned(Cf);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
fn string(value: &str) -> Owned {
    Owned(unsafe {
        CFStringCreateWithBytes(
            ptr::null(),
            value.as_ptr(),
            value.len() as isize,
            UTF8,
            false,
        )
    })
}
fn text(value: Cf) -> Option<String> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
        return None;
    }
    let mut buffer = vec![0u8; 16_001];
    if !unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr().cast(),
            buffer.len() as isize,
            UTF8,
        )
    } {
        return None;
    }
    let end = buffer.iter().position(|b| *b == 0)?;
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}
fn attribute(element: Cf, name: &str) -> Option<Owned> {
    checked_attribute(element, name).ok().flatten()
}

/// 根节点读取保留 AX 错误码，防止把目标不支持、超时和缺少窗口误报成权限失败。
fn checked_attribute(element: Cf, name: &str) -> Result<Option<Owned>, ObservationError> {
    let mut result = ptr::null();
    let code = unsafe { AXUIElementCopyAttributeValue(element, string(name).0, &mut result) };
    if attribute_available(code, !result.is_null())? {
        return Ok(Some(Owned(result)));
    }
    Ok(None)
}

/// CannotComplete 不只是超时，也可能是应用忙或通信失败，不能误报成 TCC 拒绝。
fn attribute_available(code: i32, has_value: bool) -> Result<bool, ObservationError> {
    match code {
        0 => Ok(has_value),
        -25205 | -25212 => Ok(false), // attribute unsupported / no value
        -25204 => Err(ObservationError::AccessibilityMessagingFailed),
        -25211 => Err(ObservationError::AccessibilityUnavailable),
        _ => Err(ObservationError::ApplicationUnavailable),
    }
}
fn text_attribute(element: Cf, name: &str) -> String {
    attribute(element, name)
        .and_then(|value| text(value.0))
        .unwrap_or_default()
}
fn boolean_attribute(element: Cf, name: &str) -> Option<bool> {
    attribute(element, name).and_then(|v| {
        (unsafe { CFGetTypeID(v.0) == CFBooleanGetTypeID() })
            .then(|| unsafe { CFBooleanGetValue(v.0) })
    })
}
fn array(value: Cf) -> Vec<Cf> {
    if unsafe { CFGetTypeID(value) != CFArrayGetTypeID() } {
        return Vec::new();
    }
    let count = unsafe { CFArrayGetCount(value) }.min(161);
    (0..count)
        .map(|i| unsafe { CFArrayGetValueAtIndex(value, i) })
        .collect()
}
/// 触发系统授权请求。
///
/// 与 `MacDesktop::permissions` 严格分开：查询是只读且可随时调用，请求会弹窗
/// 并写入 TCC 记录，只能由用户显式动作驱动。启动路径绝不能走到这里。
/// `CGRequest*Access` 会阻塞到用户响应，调用方必须放在 blocking 线程上，
/// 不应在持有 Host 桌面锁时执行。
pub fn request_permission(kind: PermissionKind) -> Result<PermissionRequestOutcome, String> {
    // 已授权的权限先短路：重复弹窗会让用户无法判断当前真实状态。
    let granted = match kind {
        PermissionKind::Accessibility => {
            if unsafe { AXIsProcessTrusted() } {
                true
            } else {
                prompt_accessibility()
            }
        }
        PermissionKind::InputMonitoring => {
            if unsafe { CGPreflightListenEventAccess() } {
                true
            } else {
                unsafe { CGRequestListenEventAccess() }
            }
        }
        PermissionKind::ScreenRecording => {
            if unsafe { CGPreflightScreenCaptureAccess() } {
                true
            } else {
                unsafe { CGRequestScreenCaptureAccess() }
            }
        }
        // 麦克风与其他三项不同：请求是异步的，且系统可能在回调前先展示弹窗。
        // 用同步等待，因为调用方已经在 spawn_blocking 里，不会阻塞界面线程。
        PermissionKind::Microphone => request_microphone(),
    };
    Ok(if granted {
        PermissionRequestOutcome::Granted
    } else {
        PermissionRequestOutcome::Requested
    })
}

/// `AXIsProcessTrustedWithOptions` 是非阻塞的：它把应用登记进 TCC 列表并弹窗，
/// 但立即返回当前信任状态，所以未授权时返回 false 属于正常结果，不是错误。
fn prompt_accessibility() -> bool {
    match accessibility_prompt_options() {
        Some(options) => unsafe { AXIsProcessTrustedWithOptions(options.0) },
        None => false,
    }
}

/// 构造 AXIsProcessTrustedWithOptions 所需的 `{kAXTrustedCheckOptionPrompt: true}`。
/// 单独抽出是因为测试只能在“不调用授权 API”的前提下验证这段 FFI；
/// 直接调用会让测试本身弹出系统授权框，那属于用户点击才能产生的影响。
fn accessibility_prompt_options() -> Option<Owned> {
    let key = unsafe { kAXTrustedCheckOptionPrompt };
    let value = unsafe { kCFBooleanTrue };
    if key.is_null() || value.is_null() {
        return None;
    }
    let options = Owned(unsafe {
        CFDictionaryCreate(
            ptr::null(),
            &key as *const Cf,
            &value as *const Cf,
            1,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        )
    });
    (!options.0.is_null()).then_some(options)
}

fn bounds(element: Cf) -> Option<PayloadDesktopBounds> {
    let position = attribute(element, "AXPosition")?;
    let size = attribute(element, "AXSize")?;
    let mut point = Point::default();
    let mut dimensions = Size::default();
    if !unsafe { AXValueGetValue(position.0, 1, (&mut point as *mut Point).cast()) }
        || !unsafe { AXValueGetValue(size.0, 2, (&mut dimensions as *mut Size).cast()) }
    {
        return None;
    }
    [point.x, point.y, dimensions.width, dimensions.height]
        .iter()
        .all(|n| n.is_finite())
        .then_some(PayloadDesktopBounds {
            x: point.x,
            y: point.y,
            width: dimensions.width.max(0.0),
            height: dimensions.height.max(0.0),
        })
}

#[derive(Default)]
struct InputState {
    epoch: AtomicU64,
    healthy: AtomicBool,
    stop: AtomicBool,
}
struct Monitor {
    state: Arc<InputState>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Monitor {
    fn start() -> Option<Self> {
        if !unsafe { CGPreflightListenEventAccess() } {
            return None;
        }
        let state = Arc::new(InputState::default());
        let input = state.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            // listen-only tap 不吞掉用户事件；失效时停用动作，不能悄悄恢复。
            let mask = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 22, 25, 26, 27]
                .iter()
                .fold(0u64, |mask, kind| mask | (1 << kind));
            let tap = unsafe {
                CGEventTapCreate(1, 0, 1, mask, on_input, Arc::as_ptr(&input) as *mut c_void)
            };
            if tap.is_null() {
                let _ = sender.send(false);
                return;
            }
            let tap = Owned(tap);
            let source = unsafe { CFMachPortCreateRunLoopSource(ptr::null(), tap.0, 0) };
            if source.is_null() {
                let _ = sender.send(false);
                return;
            }
            let source = Owned(source);
            let run_loop = unsafe { CFRunLoopGetCurrent() };
            unsafe { CFRunLoopAddSource(run_loop, source.0, kCFRunLoopCommonModes) };
            input
                .healthy
                .store(unsafe { CGEventTapIsEnabled(tap.0) }, Ordering::SeqCst);
            // 有界运行避免 stop 先于 Run 的竞态；退出不依赖下一次键鼠事件。
            if sender.send(true).is_ok() {
                while !input.stop.load(Ordering::SeqCst) {
                    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, true) };
                    input
                        .healthy
                        .store(unsafe { CGEventTapIsEnabled(tap.0) }, Ordering::SeqCst);
                }
            }
            input.healthy.store(false, Ordering::SeqCst);
        });
        if !receiver.recv().unwrap_or(false) {
            let _ = thread.join();
            return None;
        }
        Some(Self {
            state,
            thread: Some(thread),
        })
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.state.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
unsafe extern "C" fn on_input(_: Cf, kind: u32, event: Cf, info: *mut c_void) -> Cf {
    let state = unsafe { &*(info as *const InputState) };
    if kind >= 0xffff_fffe {
        state.healthy.store(false, Ordering::SeqCst);
    } else if !event.is_null() && unsafe { CGEventGetIntegerValueField(event, 42) } != EVENT_MARKER
    {
        state.epoch.fetch_add(1, Ordering::SeqCst);
    }
    event
}

#[derive(Default)]
pub struct MacDesktop {
    elements: Vec<Owned>,
    identities: Vec<u64>,
    window: Option<Owned>,
    window_identity: u64,
    next_identity: u64,
    monitor: Option<Monitor>,
    monitor_initialized: bool,
}
// AX 仅由 Host 互斥服务串行访问；事件回调只触碰原子状态。
unsafe impl Send for MacDesktop {}
impl DesktopDriver for MacDesktop {
    fn permissions(&mut self, now: u64) -> PayloadDesktopPermissions {
        // 权限被撤回时释放旧 tap；不能把仍存活的对象误认为监听仍受系统允许。
        if !unsafe { CGPreflightListenEventAccess() } {
            self.monitor = None;
        }
        // 首次权限查询需要建立监听；之后若 tap 失效，普通轮询不能偷偷恢复，
        // 否则旧租约和旧观察引用可能在用户不知情时继续生效。
        if !self.monitor_initialized {
            self.monitor = Monitor::start();
            self.monitor_initialized = true;
        }
        // 状态映射与请求路径共用同一个查询，避免两处魔数漂移。
        let microphone = match microphone_status() {
            0 => "not_determined",
            1 => "restricted",
            2 => "denied",
            3 => "granted",
            _ => "unavailable",
        };
        PayloadDesktopPermissions {
            accessibility: if unsafe { AXIsProcessTrusted() } {
                "granted"
            } else {
                "denied"
            }
            .into(),
            screen_recording: if unsafe { CGPreflightScreenCaptureAccess() } {
                "granted"
            } else {
                "denied"
            }
            .into(),
            input_monitoring: if unsafe { CGPreflightListenEventAccess() } {
                "granted"
            } else {
                "denied"
            }
            .into(),
            microphone: microphone.into(),
            takeover_detection: self.monitor_healthy(),
            // 4C 首版只实现 Accessibility 语义观察；截图/视觉定位必须先完成
            // 真实模型能力验证和逐任务授权，不能因系统屏幕录制权限已开而伪装可用。
            visual_fallback: PayloadDesktopVisualCapability {
                status: "unavailable".into(),
                reason: "视觉回退尚未接入；请使用 Accessibility 语义目标".into(),
            },
            checked_at_ms: now,
        }
    }
    fn input_epoch(&self) -> u64 {
        self.monitor
            .as_ref()
            .map_or(0, |m| m.state.epoch.load(Ordering::SeqCst))
    }
    fn monitor_healthy(&self) -> bool {
        self.monitor
            .as_ref()
            .is_some_and(|m| m.state.healthy.load(Ordering::SeqCst))
    }
    fn recover_input_monitor(&mut self) {
        if !self.monitor_healthy() {
            // 失效 tap 不会自行恢复；只能在 Host 作废旧租约后的显式用户入口重建。
            self.monitor = None;
            self.monitor = Monitor::start();
            self.monitor_initialized = true;
        }
    }
    fn observe(&mut self) -> Result<NativeObservation, ObservationError> {
        if !unsafe { AXIsProcessTrusted() } {
            return Err(ObservationError::PermissionDenied);
        }
        let previous = std::mem::take(&mut self.elements);
        let previous_ids = std::mem::take(&mut self.identities);
        // SystemWide 的 AXFocusedApplication 在部分应用/授权切换期间无值。
        // 先由 AppKit 确定真实前台 PID，再创建应用级 AX 根；不猜测其他应用。
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
        let system = Owned(unsafe { AXUIElementCreateSystemWide() });
        if system.0.is_null() {
            return Err(ObservationError::AccessibilityUnavailable);
        }
        // SystemWide 设置进程全局默认；应用根的覆盖只对该对象生效，
        // 不能用根对象的 timeout 代替对子控件调用的全局保护。
        unsafe { AXUIElementSetMessagingTimeout(system.0, 0.4) };
        let app = if let Some(frontmost) = frontmost.as_ref() {
            let app = Owned(unsafe { AXUIElementCreateApplication(frontmost.processIdentifier()) });
            if app.0.is_null() {
                return Err(ObservationError::ApplicationUnavailable);
            }
            app
        } else {
            checked_attribute(system.0, "AXFocusedApplication")?
                .ok_or(ObservationError::NoApplication)?
        };
        // 根窗口读取允许稍长预算；子控件仍沿用全局默认，避免单项长时间挂起。
        unsafe { AXUIElementSetMessagingTimeout(app.0, 1.0) };
        let mut pid = 0;
        if unsafe { AXUIElementGetPid(app.0, &mut pid) } != 0 || pid <= 0 {
            return Err(ObservationError::ApplicationUnavailable);
        }
        let bundle = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .and_then(|app| app.bundleIdentifier())
            .map(|id| id.to_string())
            .ok_or(ObservationError::ApplicationUnavailable)?;
        // 主窗口是同一前台应用声明的语义目标；不随意选择 AXWindows 的第一项。
        let window = match checked_attribute(app.0, "AXFocusedWindow")? {
            Some(window) => window,
            None => checked_attribute(app.0, "AXMainWindow")?.ok_or(ObservationError::NoWindow)?,
        };
        let title = text_attribute(window.0, "AXTitle");
        if !self
            .window
            .as_ref()
            .is_some_and(|old| unsafe { CFEqual(old.0, window.0) })
        {
            self.next_identity += 1;
            self.window_identity = self.next_identity;
        }
        self.window = Some(Owned(unsafe { CFRetain(window.0) }));
        let window_id = format!("{pid}:{}", self.window_identity);
        let mut queue = VecDeque::from([(window, 0)]);
        let mut elements = Vec::new();
        let mut truncated = false;
        while let Some((element, depth)) = queue.pop_front() {
            if elements.len() >= 160 {
                truncated = true;
                break;
            }
            let role = text_attribute(element.0, "AXRole");
            let subrole = text_attribute(element.0, "AXSubrole");
            let sensitive = subrole.contains("Secure")
                || role.contains("Secure")
                || boolean_attribute(element.0, "AXProtectedContent").unwrap_or(false);
            let enabled = boolean_attribute(element.0, "AXEnabled").unwrap_or(true);
            let mut actions = Vec::new();
            let mut names = ptr::null();
            if unsafe { AXUIElementCopyActionNames(element.0, &mut names) } == 0 && !names.is_null()
            {
                let names = Owned(names);
                if array(names.0)
                    .iter()
                    .any(|name| text(*name).as_deref() == Some("AXPress"))
                {
                    actions.push("press".into());
                }
            }
            let mut settable = false;
            if !sensitive
                && unsafe {
                    AXUIElementIsAttributeSettable(element.0, string("AXValue").0, &mut settable)
                } == 0
                && settable
            {
                actions.push("set_value".into());
            }
            if role == "AXWindow" {
                actions.push("focus".into());
            }
            if role == "AXScrollArea" {
                actions.push("scroll".into());
            }
            let handle = self.elements.len();
            // CFEqual 比较 AX 对象身份；不把指针、哈希碰撞或树索引当身份。
            let identity = previous
                .iter()
                .position(|old| unsafe { CFEqual(old.0, element.0) })
                .and_then(|i| previous_ids.get(i).copied())
                .unwrap_or_else(|| {
                    self.next_identity += 1;
                    self.next_identity
                });
            let raw_value = if sensitive {
                None
            } else {
                attribute(element.0, "AXValue")
            };
            let value_truncated = raw_value.as_ref().is_some_and(|v| unsafe {
                CFGetTypeID(v.0) == CFStringGetTypeID()
                    && (CFStringGetLength(v.0) > 4000 || text(v.0).is_none())
            });
            let value = raw_value
                .and_then(|v| text(v.0))
                .map(|v| v.chars().take(4000).collect());
            elements.push(NativeElement {
                handle,
                identity,
                role,
                label: if sensitive {
                    String::new()
                } else {
                    let title = text_attribute(element.0, "AXTitle");
                    if title.is_empty() {
                        text_attribute(element.0, "AXDescription")
                    } else {
                        title
                    }
                },
                value,
                value_truncated,
                focused: boolean_attribute(element.0, "AXFocused").unwrap_or(false),
                enabled,
                sensitive,
                actions,
                bounds: bounds(element.0),
                depth,
            });
            if !sensitive {
                if let Some(children) = attribute(element.0, "AXChildren") {
                    let children_values = array(children.0);
                    if unsafe { CFArrayGetCount(children.0) } > 161 {
                        truncated = true;
                    }
                    if depth < 8 {
                        for child in children_values {
                            unsafe { CFRetain(child) };
                            queue.push_back((Owned(child), depth + 1));
                        }
                    } else if !children_values.is_empty() {
                        truncated = true;
                    }
                }
            }
            self.elements.push(element);
            self.identities.push(identity);
        }
        if NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .is_none_or(|current| current.processIdentifier() != pid)
        {
            return Err(ObservationError::TargetChanged);
        }
        Ok(NativeObservation {
            bundle_id: bundle,
            process_id: pid as u32,
            window_id,
            title,
            elements,
            truncated,
        })
    }
    fn perform(&mut self, action: &DesktopAction, handle: Option<usize>) -> Result<(), String> {
        if !self.monitor_healthy() {
            return Err("Human takeover monitor unavailable".into());
        }
        if let DesktopAction::LaunchApp { bundle_id } = action {
            if !valid_bundle_id(bundle_id) {
                return Err("Invalid bundle ID".into());
            }
            // 固定程序和参数数组，不接受 URL、路径、shell 或应用启动参数。
            return std::process::Command::new("/usr/bin/open")
                .args(["-b", bundle_id])
                .status()
                .map_err(|_| "Application launch unavailable".into())
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err("Application launch uncertain".into())
                    }
                });
        }
        let element = handle
            .and_then(|id| self.elements.get(id))
            .ok_or("Target unavailable")?;
        let code = match action {
            DesktopAction::Click { .. } => unsafe {
                AXUIElementPerformAction(element.0, string("AXPress").0)
            },
            DesktopAction::Type { text, .. } => unsafe {
                AXUIElementSetAttributeValue(element.0, string("AXValue").0, string(text).0)
            },
            DesktopAction::FocusWindow { .. } => unsafe {
                AXUIElementPerformAction(element.0, string("AXRaise").0)
            },
            DesktopAction::Key { key, modifiers, .. } => {
                let code = key_code(key).ok_or("Unsupported key")?;
                let flags = modifier_flags(modifiers).ok_or("Unsupported modifiers")?;
                if !boolean_attribute(element.0, "AXFocused").unwrap_or(false) {
                    return Err("Keyboard target is not focused".into());
                }
                let down = unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, true) };
                let up = unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) };
                if down.is_null() || up.is_null() {
                    if !down.is_null() {
                        unsafe { CFRelease(down) };
                    }
                    if !up.is_null() {
                        unsafe { CFRelease(up) };
                    }
                    return Err("Keyboard events unavailable".into());
                }
                let down = Owned(down);
                let up = Owned(up);
                // 一组结构化按键按下/松开是一个原子输入；标记排除自身的接管事件。
                for event in [down.0, up.0] {
                    unsafe {
                        CGEventSetFlags(event, flags);
                        CGEventSetIntegerValueField(event, 42, EVENT_MARKER);
                        CGEventPost(0, event);
                    }
                }
                return Ok(());
            }
            DesktopAction::Scroll {
                direction, amount, ..
            } => {
                if !(1..=8).contains(amount) {
                    return Err("Invalid scroll amount".into());
                }
                let b = bounds(element.0).ok_or("Scroll target has no bounds")?;
                let delta = i32::from(*amount);
                let (vertical, horizontal) = match direction.as_str() {
                    "up" => (delta, 0),
                    "down" => (-delta, 0),
                    "left" => (0, delta),
                    "right" => (0, -delta),
                    _ => return Err("Invalid scroll direction".into()),
                };
                let event = unsafe {
                    CGEventCreateScrollWheelEvent(ptr::null(), 1, 2, vertical, horizontal)
                };
                if event.is_null() {
                    return Err("Scroll event unavailable".into());
                }
                let event = Owned(event);
                unsafe {
                    CGEventSetLocation(
                        event.0,
                        Point {
                            x: b.x + b.width / 2.0,
                            y: b.y + b.height / 2.0,
                        },
                    );
                    CGEventSetIntegerValueField(event.0, 42, EVENT_MARKER);
                    CGEventPost(0, event.0);
                }
                return Ok(());
            }
            _ => return Err("Unsupported native action".into()),
        };
        if code == 0 {
            Ok(())
        } else {
            Err("Native action could not be confirmed".into())
        }
    }
}

fn valid_bundle_id(id: &str) -> bool {
    id.len() <= 200
        && id.contains('.')
        && id.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}
fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "return" => 36,
        "tab" => 48,
        "escape" => 53,
        "space" => 49,
        "left" => 123,
        "right" => 124,
        "up" => 126,
        "down" => 125,
        "backspace" => 51,
        "a" => 0,
        "c" => 8,
        "v" => 9,
        "s" => 1,
        "z" => 6,
        _ => return None,
    })
}
fn modifier_flags(modifiers: &[String]) -> Option<u64> {
    let mut result = 0;
    for name in modifiers {
        let flag = match name.as_str() {
            "command" => 1 << 20,
            "shift" => 1 << 17,
            "option" => 1 << 19,
            "control" => 1 << 18,
            _ => return None,
        };
        if result & flag != 0 {
            return None;
        }
        result |= flag;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observation_errors_distinguish_missing_values_from_messaging_failures() {
        assert_eq!(attribute_available(0, true), Ok(true));
        assert_eq!(attribute_available(0, false), Ok(false));
        assert_eq!(attribute_available(-25205, false), Ok(false));
        assert_eq!(attribute_available(-25212, false), Ok(false));
        assert_eq!(
            attribute_available(-25204, false),
            Err(ObservationError::AccessibilityMessagingFailed)
        );
        assert_eq!(
            attribute_available(-25211, false),
            Err(ObservationError::AccessibilityUnavailable)
        );
        assert_eq!(
            attribute_available(-25202, false),
            Err(ObservationError::ApplicationUnavailable)
        );
    }
    #[test]
    fn the_accessibility_prompt_dictionary_is_accepted_by_core_foundation() {
        // 只构造并读回字典，不调用 AXIsProcessTrustedWithOptions：测试不得弹窗。
        let options = accessibility_prompt_options().expect("prompt options");
        assert_eq!(unsafe { CFDictionaryGetCount(options.0) }, 1);
        let mut value = ptr::null();
        let found = unsafe {
            CFDictionaryGetValueIfPresent(options.0, kAXTrustedCheckOptionPrompt, &mut value)
        };
        assert!(found);
        assert!(unsafe { CFBooleanGetValue(value) });
    }

    #[test]
    fn native_input_allowlists_do_not_accept_scripts_or_macros() {
        assert!(valid_bundle_id("com.apple.TextEdit"));
        for id in [
            "com.apple.TextEdit --args",
            "/Applications/TextEdit.app",
            "a..b",
            "-b",
        ] {
            assert!(!valid_bundle_id(id));
        }
        assert_eq!(key_code("return"), Some(36));
        assert_eq!(key_code("return;open"), None);
        assert_eq!(modifier_flags(&["command".into(), "command".into()]), None);
    }
}
