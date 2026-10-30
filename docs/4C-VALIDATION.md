# 4C Native Desktop and Lark Validation

## 2026-10-30：最小演示过线定稿

定稿来源：产品负责人草稿，锦阳于 Semi-OS 群聊确认「可以定稿」。

**本轮最小演示过线：**

1. A1+A2：四项权限 + 重建后授权保持（固定证书、`open` 启动）
2. B1+B2：TextEdit 观察 + 英文原子输入 + Host 读回
3. B4：一条用户可见通用应用闭环

**不进本轮：**视觉回退（保持 unavailable）、PV.6、Worker 发行打包。

**口径：**观察 → 单原子动作 → Host 读回；unknown 禁止盲重试。

下文只使用三个标签：

- **最小过线**：本轮演示必须由真人在真实 macOS `.app` 上通过。
- **第二轮**：仍然要做，但不计入本轮过线。
- **不验**：本轮明确不做。不能写成过线条件，也不能用历史证据算成已验。

Semi-OS 是目标仓库；LumiCore 只作设计参考。桌面路径仍由 Host 拥有。
屏幕录制已授权，或已经存在截图 Artifact，都不表示视觉能力可用。

历史自动证据、签名与 TCC 说明、P4C.1 步骤，以及 2026-10-26 诊断都保留。
它们分别是 A1+A2 的操作步骤或当时的证据，不能互相替代，也不能代替
B1+B2 或 B4。

## 最小过线

### A1+A2：四项权限 + 重建后授权保持

本轮要验：

- Accessibility、Input Monitoring、Screen Recording、Microphone 四项都由
  客户端显式请求；回到应用里重新检查后，四项均为已授权。
- 签名身份是固定证书 `Semi-OS Local Signing`。指定要求里是
  `certificate root`，不是 `cdhash`。
- 用 `open` / LaunchServices 启动
  `target/debug/bundle/macos/Semi-OS.app`。`tauri dev` 和直接启动包内
  可执行文件都不是验收入口。
- 退出、不改内容重建、再次 `open` 后，四项授权仍然保持。这一步才是
  签名身份稳定的证明。

屏幕录制属于这四项权限。它只证明 TCC 允许采集，不打开视觉回退
（见「不验」）。

操作步骤见「Native Acceptance Procedure (P4C.1)」。走完该步骤只表示
A1+A2 通过，不代替 B1+B2 或 B4。

### B1+B2：TextEdit 观察 + 英文原子输入 + Host 读回

本轮要验的是 **英文** TextEdit 路径：

1. 对 TextEdit 做一次新鲜语义观察。观察对象必须是 TextEdit，不是
   Semi-OS 自己的窗口，也不是 2026-10-26 对 Codex 的只读诊断。
2. 一次原子英文输入。
3. Host 持有的读回，能核对刚刚写入的英文文本。

中文输入、Retina、多显示器，以及把启动/聚焦单独做成验收矩阵，都不在
这条过线里，见「第二轮」。

### B4：一条用户可见通用应用闭环

本轮只要求 **一条** 用户可见的通用应用闭环，顺序就是口径：

1. 新鲜观察；
2. 一个原子动作；
3. Host 读回。

证明不足时结果是 `unknown`，先对账，禁止盲重试。这一条通过，不表示
多应用矩阵、人工接管或动作中途重启已经验收。

## 第二轮

下列项仍然要做，不计入 2026-10-30 最小演示过线：

- TextEdit 中文输入。
- 英文原子路径之外的 TextEdit 专项：把窗口聚焦、Retina、多显示器做成
  独立验收。最小过线只要求能对 TextEdit 完成一次英文观察、原子输入和
  Host 读回。
- 真人接管，以及接管后桌面租约和元素引用失效。
- 原生动作进行中的 Worker 或应用重启。
- 应用启动后窗口异步出现。这时仍可能返回 `unknown`。禁止因为窗口暂时
  未就绪而自动重复启动；必须重新观察或人工核对。
- 真实 Lark CLI：身份、文档搜索/读取、经确认的测试会话发送，以及超时
  对账。下文的 Lark Fixture 不能代替这一项。
- 真实应用关闭、断网，以及权限等待中的恢复。

## 不验

本轮明确不验收，保持现状，不写入过线清单：

- **视觉回退 / 受约束视觉模型路径。** 保持 `unavailable`。不要求真实
  图片模型调用、窗口或观察版本绑定、敏感界面拒绝证据。Screen Recording
  授权、截图 Artifact 或截图变化，都不是这项的通过证明，也不是消息已
  发送或业务已成功的证明。
- **PV.6** 原生真人语音体验（麦克风按键、扬声器、透明窗口等）。记录仍在
  `docs/VOICE-OPTIMIZATION-VALIDATION.md`，不计入 4C 最小演示过线。
- **Worker 发行打包。** bundle 的 Resources 当前不含 Worker；
  `start_worker` 仍依赖编译期仓库、本地 Node 与依赖。当前构建可以用于
  本机验证，本轮不把它当成可移植发行包来验收。

## Automated Evidence

历史自动证据，不是最小过线的替代品。它说明策略和恢复在 Fixture 里成立，
不能证明真实 TCC 授权、TextEdit 英文输入，或那一条用户可见闭环。

- `pnpm check`: passed on 2026-10-24, including workspace command checks,
  generated protocol verification, Prettier, TypeScript, ESLint, Rust Clippy,
  all JavaScript and Rust tests, JavaScript and Rust builds, and
  `git diff --check`.
- `pnpm --filter @semi-os/agent-worker typecheck`
- `pnpm --filter @semi-os/agent-worker test`: 124 passed.
- `node --experimental-strip-types --test packages/agent-worker/src/lark/lark-service.test.ts`:
  9 passed.
- `cargo test -p semi-os-storage --test recovery`: 12 passed.
- Rust workspace tests include 61 Host tests, 32 Storage unit tests, 12 Storage
  recovery tests, 7 protocol tests, the Node/Rust contract runner, and the
  native desktop allowlist test.

The deterministic desktop fixtures cover permission denial, unavailable
takeover monitoring, duplicate targets, stale observations, changed native
identity, lease generation changes, dispatch failure, post-dispatch takeover,
truncated readback, restart invalidation, unknown outcomes, and permission
changes that invalidate a lease issued before them. Storage recovery proves
that `possibly_dispatched` becomes `unknown` after restart and cannot
transition back to a dispatchable stage.

Lark fixtures cover bounded structured commands, credential-shaped field
redaction, stable idempotency keys, exact chat-history reconciliation,
unreconcilable timeout, unavailable CLI, authentication failure, user-target
timeout without an empty chat lookup, and invalid or oversized parameters.
真实 Lark 身份和测试会话发送属于「第二轮」。

## Native Permission Request

本节支撑 **最小过线 A1**。它说明显式请求路径和 hardened runtime 约束。
它不说明视觉能力，也不说明 Worker 发行打包。

The client exposes an explicit `request_desktop_permission` command for
Accessibility, Input Monitoring, Screen Recording and Microphone. The closed
permission set lives in `crates/desktop-macos/src/lib.rs`
(`PermissionKind::parse`) and mirrors
`apps/desktop/src/ui/desktop-permission-request.ts`; any other name is rejected
before reaching TCC.

Microphone is requestable for a different reason than the other three: TCC only
lists a process under "Privacy & Security → Microphone" after that process has
requested the service, so an app that never asks is an app the user cannot find
in System Settings. Its request goes through
`AVCaptureDevice.requestAccessForMediaType` on a blocking thread and waits for
the callback, because the macOS API is asynchronous and a timeout must not be
reported as a grant.

Permission state stays a query: `MacDesktop::permissions` only reads TCC.
`AXIsProcessTrustedWithOptions`, `CGRequestListenEventAccess`,
`CGRequestScreenCaptureAccess` and `AVCaptureDevice.requestAccess` are reachable
only through an explicit user click, never from startup or polling. A granted
request revokes the current desktop lease so an observation or approval taken
before the grant cannot be dispatched with the new capability.

### Hardened runtime and the audio-input entitlement

The bundle is signed with hardened runtime, which Tauri enables by default.
The earlier ad-hoc build reported `flags=0x10002(adhoc,runtime)`; the current
bundle uses the fixed certificate described below. Under hardened
runtime TCC refuses to prompt for microphone unless the signature carries
`com.apple.security.device.audio-input`; without it the app never appears in the
Microphone list and every capture request is denied with
`requires entitlement com.apple.security.device.audio-input but it is missing`.
`apps/desktop/src-tauri/entitlements.plist` declares exactly that one
entitlement. Accessibility, Input Monitoring and Screen Recording are not
gated by entitlements and must not be added there.

## Ad-hoc signing and TCC identity

本节支撑 **最小过线 A2**。稳定证书让重建后 TCC 仍能匹配已有授权。

With `signingIdentity: "-"` the bundle is ad-hoc signed and its cdhash changes on
every rebuild. TCC binds a stored grant to the code requirement of the grantor,
so **a rebuild invalidates previously granted Accessibility, Input Monitoring,
Screen Recording and Microphone permissions**. Symptoms are an app that stays
"未授权" after the switches look enabled in System Settings, plus
`Failed to match existing code requirement` in the TCC log.

`signingIdentity` is therefore set to `Semi-OS Local Signing`, a self-signed
certificate created by:

```bash
bash scripts/setup-code-signing-cert.sh
```

The script is idempotent and must be run once per machine, by the developer: it
writes to the login keychain (prompting for its password to lift the private-key
ACL). Once the identity exists, TCC matches the certificate root instead of a
per-build hash, so rebuilds keep their grants.

Two constraints the script works around, both verified on macOS:

- `security import` only understands legacy PKCS#12 (RC2/3DES PBE with a SHA1
  MAC). OpenSSL 3 defaults to PBKDF2 + AES-256 + SHA256 and fails with
  `MAC verification failed during PKCS12 import (wrong password?)` — an error
  that has nothing to do with the password. The script therefore tries
  `-legacy`, then explicit `PBE-SHA1-3DES`, then LibreSSL, treating a successful
  import as the only success criterion.
- Trusting the certificate is **not** required to sign. `codesign` uses any
  identity reachable through the keychain search list, so the identity reports
  `CSSMERR_TP_NOT_TRUSTED` yet still signs. Trust only affects `spctl` /
  Gatekeeper assessment and the `find-identity -v` listing. The script attempts
  the trust setting with a 90s timeout because macOS raises an interactive
  authentication dialog for it, and continues if that is declined.

The designated requirement confirms which identity is in play:

```bash
codesign -d -r- target/debug/bundle/macos/Semi-OS.app
# stable:   designated => identifier "dev.semios.desktop" and certificate root = H"..."
# unstable: designated => cdhash H"..." or cdhash H"..."
```

The certificate root hash does not change across rebuilds (verified by signing
two separate binaries with the same identity: identical root hash). The
`identifier` component comes from `CFBundleIdentifier`, so it is stable too.

If the identity is missing, the build fails with
`Semi-OS Local Signing: no identity found`; run the script and rebuild.

When switching an existing install from ad-hoc to the certificate, old records
may no longer match. First confirm the current bundle identity and reauthorize
that application in System Settings. Only if the records still fail to match
should the user explicitly choose to clear the affected grants; this removes
existing authorization and is not a routine repair command:

```bash
tccutil reset Accessibility dev.semios.desktop
tccutil reset ScreenCapture dev.semios.desktop
tccutil reset ListenEvent dev.semios.desktop
tccutil reset Microphone dev.semios.desktop
```

## Native Acceptance Procedure (P4C.1)

**最小过线 A1+A2 的必做步骤。** 完成下面 1–9 步只表示四项权限和重建后
授权保持通过。B1+B2 与 B4 另验。视觉回退、PV.6、Worker 发行打包不在本
步骤里。

TCC attributes permission to the bundle, not to a bare binary, so acceptance
runs against a debug `.app`:

1. `bash scripts/setup-code-signing-cert.sh`（每台机器只需一次；需要登录钥匙串
   密码，因为它要解除私钥访问限制）
2. `pnpm --filter @semi-os/desktop exec tauri build --debug`
3. `codesign -d -r- target/debug/bundle/macos/Semi-OS.app`，确认指定要求里是
   `certificate root` 而不是 `cdhash`
4. 如果是首次从 ad-hoc 切到证书签名，先在系统设置中重新授权当前 App。
   只有已确认旧记录不匹配且用户决定清理时，才重置对应项目：

   ```bash
   tccutil reset Accessibility dev.semios.desktop
   tccutil reset ScreenCapture dev.semios.desktop
   tccutil reset ListenEvent dev.semios.desktop
   tccutil reset Microphone dev.semios.desktop
   ```

5. `open target/debug/bundle/macos/Semi-OS.app` (the workspace shares one
   `target/` directory, so the bundle is not under `apps/desktop`)
6. In the client: Settings, Desktop Permissions. Use `请求授权` on
   Accessibility, Input Monitoring, Screen Recording and Microphone in turn.
7. Expect `Semi-OS` to appear in the matching System Settings privacy pane,
   including Microphone. `requested` means the system was asked and the app is
   still untrusted; if no dialog appeared, the toggle must be enabled manually.
8. Return to the app and use `重新检查`; all four should read `已授权` and the
   takeover-listening warning must disappear.
9. Quit, rebuild without changing anything, and relaunch `Semi-OS.app`; the
   grants must survive the rebuild. That final step is the actual proof that the
   signing identity is stable.

Microphone needs one extra check that the other three do not: confirm the
signature carries the entitlement before blaming TCC.

```bash
codesign -d --entitlements :- target/debug/bundle/macos/Semi-OS.app
# must contain com.apple.security.device.audio-input
```

The current bundle is signed via
`bundle.macOS.signingIdentity: "Semi-OS Local Signing"` with identifier
`dev.semios.desktop` and a sealed Info.plist. Do not diagnose a current grant
failure by assuming the former ad-hoc configuration is still active.
Screen Recording may need an application restart before it takes effect.
`tauri dev` runs a bare binary and is not the permission-acceptance entrypoint.

## 2026-10-26：授权后无法使用的排查

**历史诊断，不是本轮过线记录。** 当时用 `open` 启动的只读观察证明：固定
证书下四项权限为 `granted`，并能读到前台 Codex 的控件。这不能代替
TextEdit 的 B1+B2，也不能代替 B4 的用户可见闭环。直接从 shell 启动包内
可执行文件的权限结果，仍然不能当作验收。

### 已修复的代码路径

- `native.rs` 优先由 NSWorkspace 前台 PID 创建 AX 应用根，焦点窗口缺失时
  回退同应用主窗口；观察结束核对前台 PID，避免跨窗口目标错配。
- AX 根读取区分缺值、通信失败、接口不可用和应用失效；Host 不再将所有观察
  错误显示为“检查权限”。子控件保留全局通信超时，根节点独立设置预算。
- 失效 tap 由用户“重新检查”/恢复或已成功授权入口重建；此前旧 `Some(Monitor)`
  会永久保留而无法恢复。重建前撤销旧租约、批准与引用，普通焦点刷新不重建。
- 客户端权限设置增加“只读自检”，与 Worker/LLM 无关；已有桌面占用时拒绝
  自检，不覆盖任务的原生目标。

### 真实 bundle 证据

产物：`target/debug/bundle/macos/Semi-OS.app`。
`codesign -d -r-` 返回 identifier `dev.semios.desktop` 与 certificate root
`d56135589729e9128a38aae5472f01db5f50d3d9`，不是 ad-hoc。

```bash
open -n -g -W target/debug/bundle/macos/Semi-OS.app \
  --stdout /tmp/semi-os-desktop-diagnostic-20261026.json \
  --stderr /tmp/semi-os-desktop-diagnostic-20261026.stderr \
  --args --desktop-diagnostic
```

2026-10-26 实测：四项权限均为 `granted`，`takeoverDetection: true`，
`status: observed`，前台应用 `com.openai.codex`，读取 11 个控件，未截断。
相同可执行文件直接由 shell 启动时 Accessibility/Input Monitoring 为 denied；
该结果不能替代由 LaunchServices 启动 App 的授权验收。该次诊断未重置 TCC
或改动钥匙串，也没有以控件数量冒充实际业务动作验证。

最新代码再次 `tauri build --debug` exit=0 后，以同一启动方式复测仍为四项
`granted`、监听健康、`observed`，前台 Codex 12 个控件，未截断。
`codesign --verify --deep --strict --verbose=2` 通过，授权在本次重建后保持。
`pnpm check` exit=0，包含格式、类型、lint/Clippy、Rust check、全量测试与构建、
`git diff --check`；其中 desktop-macos 5、Host 68、agent-worker 140 tests。
前端仍有既有大 chunk 警告；本机构建未配置 Apple 公证，不宣称发行公证通过。

设置中的“只读自检”观察点击时的前台应用，一般是 Semi-OS 本身；要测试其他
应用，请让目标保持前台并通过上面的后台启动命令运行诊断。不要根据对自己
窗口的观察成功宣布 TextEdit 或其他目标已通过。

### 和当前过线边界的关系

- 重建后四项 `granted` 是 A2 的支持证据。最小过线仍须按 P4C.1 由真人走完
  请求、重新检查，以及不改内容的再重建。
- 只读自检和 Codex 控件计数不是 B1+B2，也不是 B4。
- 中文输入、真人接管、动作中重启、真实 Lark：第二轮。
- 视觉回退、PV.6、把 Worker 打进 bundle：不验。

## Known Conservative Behavior

这些约束在最小过线和后续轮次都有效：

- Background workflows must obtain a fresh user-approved desktop lease for each
  desktop occupation. The general 4B hosted grant does not silently authorize
  foreground control.
- A timed-out `userId` Lark send returns `unknown_send` without querying an empty
  chat ID or retrying. A `chatId` send may reconcile against that exact chat
  history.
- Unknown or possibly-applied desktop and Lark operations are never
  automatically replayed.
