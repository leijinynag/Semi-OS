# 4C Native Desktop and Lark Validation

## Scope

This document records the current validation boundary for 4C. Semi-OS is the
target repository; LumiCore is only a reference for design ideas. The desktop
path remains Host-owned and follows:

1. fresh semantic observation;
2. one atomic action;
3. Host-owned readback verification;
4. `unknown` plus reconciliation when proof is insufficient.

No visual capability is considered available merely because Screen Recording is
granted or a screenshot Artifact exists.

## Automated Evidence

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

## Native Permission Request

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

### Ad-hoc signing and TCC identity

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
该结果不能替代由 LaunchServices 启动 App 的授权验收。本轮未重置 TCC 或改动
钥匙串，也没有以控件数量冒充实际业务动作验证。

最新代码再次 `tauri build --debug` exit=0 后，以同一启动方式复测仍为四项
`granted`、监听健康、`observed`，前台 Codex 12 个控件，未截断。
`codesign --verify --deep --strict --verbose=2` 通过，授权在本次重建后保持。
`pnpm check` exit=0，包含格式、类型、lint/Clippy、Rust check、全量测试与构建、
`git diff --check`；其中 desktop-macos 5、Host 68、agent-worker 140 tests。
前端仍有既有大 chunk 警告；本机构建未配置 Apple 公证，不宣称发行公证通过。

设置中的“只读自检”观察点击时的前台应用，一般是 Semi-OS 本身；要测试其他
应用，请让目标保持前台并通过上面的后台启动命令运行诊断。不要根据对自己
窗口的观察成功宣布 TextEdit 或其他目标已通过。

### 未完成的边界

- TextEdit 中文输入、真实动作批准、人工接管、跨重启授权仍需真人完整验收。
- 应用启动后的窗口异步出现仍可能返回 `unknown`；禁止因窗口暂时未就绪
  自动重复启动，必须重新观察或人工核对。
- bundle 的 Resources 当前不含 Worker；`start_worker` 仍依赖编译期仓库、
  本地 Node 与依赖。当前可用于本机验证，不是独立可移植的发行包。

Lark fixtures cover bounded structured commands, credential-shaped field
redaction, stable idempotency keys, exact chat-history reconciliation,
unreconcilable timeout, unavailable CLI, authentication failure, user-target
timeout without an empty chat lookup, and invalid or oversized parameters.

## Manual Acceptance Still Required

The following are intentionally not marked as complete in `tasks.md`:

- macOS Accessibility, Screen Recording, Input Monitoring and microphone
  permission states in the real Tauri application. The app can now request the
  four explicitly, but a human must still run the native acceptance
  procedure above and observe the real TCC panes;
- TextEdit launch/focus, semantic observation, Chinese and English input,
  readback verification, Retina/multi-display behavior and real user takeover;
- Worker or application restart while a native action is in flight;
- real Lark CLI identity, document search/read, confirmed test-session send and
  timeout reconciliation;
- a real image-capable model call for the constrained visual fallback.

A real permission grant is not evidence that a visual model can interpret an
image. A changed screenshot is not evidence that a message was sent or that a
business operation succeeded.

## Known Conservative Behavior

- Background workflows must obtain a fresh user-approved desktop lease for each
  desktop occupation. The general 4B hosted grant does not silently authorize
  foreground control.
- A timed-out `userId` Lark send returns `unknown_send` without querying an empty
  chat ID or retrying. A `chatId` send may reconcile against that exact chat
  history.
- Unknown or possibly-applied desktop and Lark operations are never
  automatically replayed.
