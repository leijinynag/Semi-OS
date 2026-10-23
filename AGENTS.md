# AGENTS.md

## Project

Semi-OS is a local-first, voice-first desktop agent. It accepts spoken
intentions, uses a Pi-backed Agent Loop, operates browsers and macOS
applications, delegates work to local Coding Agents, and reports verified
results by voice.

The authoritative product and architecture decisions live in:

- `docs/DESIGN.md`
- `docs/DECISIONS.md`
- `tasks.md`

Read those files before changing architecture, process boundaries, task
lifecycle, memory behavior, voice behavior or tool contracts.

## Current status

The repository is currently in the architecture baseline stage. The target
implementation is:

```text
Tauri + React + TypeScript
        ↓
Rust Host
        ↕ local JSONL RPC
supervised Node Agent Worker
        ↓
Pi Agent Runtime + tools + Skills + providers
```

Do not describe planned modules as implemented. Keep design proposals,
verified external capabilities and shipped behavior clearly separated.

## Repository layout

Use the following target boundaries unless the design documents are updated
first:

```text
apps/desktop/              React UI and Tauri entrypoint
crates/host/               Rust lifecycle, policy, supervisor and commands
crates/desktop-macos/      macOS Accessibility and screen observation
crates/storage/            SQLite schema, migrations and repositories
packages/agent-worker/     Node worker, Pi adapter and orchestration
packages/protocol/         Shared versioned protocol schemas and generated types
packages/tool-sdk/         Tool contracts, receipts and verification types
packages/skills/           Built-in trusted Skills
packages/shared/           Runtime-neutral domain types
tests/contract/            Rust/Node/UI protocol contract tests
tests/integration/         Provider and runtime integration tests
tests/e2e/                 Full application workflows
docs/                      Design, decisions, diagrams and publishing sources
```

Keep ownership explicit:

- React renders state and emits user intent. It does not execute privileged
  operations or infer task state by parsing model prose.
- Rust is the authority for OS permissions, native desktop control, policy,
  SQLite, secrets and process supervision.
- Node owns Pi sessions, voice provider orchestration, dynamic tools, Skills,
  browser adapters and Coding Agent child processes.
- Pi remains behind `AgentRuntimeAdapter`. Do not fork or bind product code
  directly to unstable Pi internals without recording the reason.
- Pi-native file and shell tools should be reused. Add a Semi-OS tool only
  when Pi does not own the capability or when a Host policy boundary requires
  it.

## Technology rules

### TypeScript and Node

- Use TypeScript with strict mode enabled.
- Prefer small pure functions and explicit domain types over `any`,
  inheritance-heavy abstractions or implicit global state.
- Use discriminated unions for protocol messages, task states, tool results and
  provider events.
- Validate all process and IPC boundaries at runtime. Treat external JSON as
  untrusted input.
- Keep provider-specific SDK calls inside provider adapters.
- Use async cancellation with `AbortSignal`; do not hide long-running work in
  untracked promises.
- Use the repository's package manager and lockfile once the workspace is
  bootstrapped. Do not introduce a second package manager.
- Use `pnpm` workspaces for JavaScript packages.
- Format with Prettier and lint with ESLint when those tools are present.
- Test with the repository's configured runner, expected to be Vitest for unit
  and contract tests unless the implementation documents a better fit.
- Required quality checks are explicit root commands: `pnpm lint`,
  `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `git diff --check`, plus the applicable Rust checks. Do not hide required
  checks behind root-level `--if-present`.
- `schemas/protocol.schema.json` is the single protocol source of truth.
  Runtime validation must reject unknown kinds, malformed payloads and
  unsupported protocol versions at the process boundary.

### React and Tailwind CSS

- Use React with TypeScript. Components should receive typed props and expose
  behavior through domain callbacks.
- Use Tailwind CSS for application styling and keep shared visual tokens in a
  small theme layer rather than scattering arbitrary values.
- Prefer existing component primitives and the local design system before
  creating one-off UI patterns.
- Use `@phosphor-icons/react` for standard interface icons. Import third-party
  icons only through the local semantic icon adapter (for example,
  `ui/icons.ts`); business components must not bind directly to library icon
  names. This keeps future visual-system changes local to one mapping layer.
- Choose Phosphor weights intentionally: use `regular` for normal navigation,
  `bold` for compact controls, and reserve `fill` or `duotone` for active or
  branded states. Icon-only controls need accessible labels and tooltips.
- Core assistant visuals such as particles, waveforms and the central orb are
  product-owned effects, not icon-library assets.
- 用户指定的 React Bits 输入控件保留提供的 JavaScript/CSS 源码与依赖，
  位于 `ui/react-bits/`；允许其内部使用原生 Hugeicons，不扩散到业务组件。
  业务调用提供 `.d.ts` 类型边界；语音控件不得创建第二个采集器。
- Keep the desktop assistant and client as separate surfaces with shared
  domain state, not duplicated business logic.
- UI consumes structured events and snapshots. It must not parse assistant
  prose to determine whether a task succeeded, failed or is waiting.
- The desktop assistant may use particles, mouse-following motion and
  speech-synchronized waveform effects. Keep those effects in presentation
  components and do not make them the source of task semantics.
- Avoid decorative card nesting, oversized marketing layouts and visual
  complexity that hides the current task or confirmation action.
- Every loading, empty, error, paused, cancelled and confirmation state needs
  an intentional rendering path.

### Rust

- Use stable Rust and the repository's pinned toolchain when one exists.
- Format with `cargo fmt` and lint with `cargo clippy --all-targets
--all-features -- -D warnings` when the workspace supports it.
- Prefer typed structs and enums with explicit serialization over unstructured
  maps.
- Keep unsafe code out of the Host unless a platform integration requires it;
  isolate and document any such block.
- Rust owns SQLite access. Other processes communicate through typed commands
  and events instead of opening the database directly.
- 工作流只读查询集中在 `crates/storage/src/workflow_queries.rs`，公开接口
  返回 `workflow_dto.rs` 的明确 DTO；原始 JSON 查询只允许 Storage 内部使用。
  状态变更与查询分开，工作流状态机测试保留在 `workflow_tests.rs`。
  写入接口也必须返回快照 DTO；协调领取、检查点和决策回执使用明确类型，
  只在 Host/IPC 边界序列化为兼容 JSON，不得以任意 `Value` 返回核心结果。
  领取前必须校验持久检查点和事件，避免损坏数据留下新的在途租约。
  兼容回执必须先解码，再发送成功回执或发布 UI；启动恢复遇到
  损坏记录必须明确报错，不能用 `.ok()` 或空列表静默隐藏查询失败。
- Map OS and provider failures into structured domain errors. Do not leak
  secrets, stack traces or raw provider payloads to the UI.
- macOS desktop actions must follow fresh observation, one atomic action and
  Host-owned verification.

### CSS, assets and diagrams

- Default to ASCII in source files unless the file already uses another
  character set or user-facing Chinese text requires it.
- 关键文件必须写清楚中文注释，重点解释架构边界、跨进程协议、状态机、
  风险策略、并发/取消、恢复与验证等不易从代码直接看出的设计意图。
- 注释应说明“为什么这样设计”和必须保持的约束，不要逐行复述代码。
  公共类型、核心入口和关键校验函数优先使用对应语言的文档注释。
- 自动生成文件不要手动补注释；应在生成器中维护中文文件头或说明。
  标准 JSON（例如 `schemas/protocol.schema.json`）不支持注释，相关设计说明
  应写在生成器、相邻源码或文档中，不能为了注释破坏文件格式。
- 修改关键逻辑时同步维护相关中文注释；如果注释与实现冲突，以修正二者为
  同一个交付要求。
- Use stable dimensions for floating controls, waveform surfaces, timelines and
  tool rows so dynamic content cannot shift layout unexpectedly.
- Keep diagrams and visual assets under `docs/assets/` or a feature-owned asset
  directory. Do not add generated caches or local browser profiles.
- Use the existing diagram conventions before introducing a new diagram format.

## Architecture invariants

The following are non-negotiable unless `docs/DECISIONS.md` is updated:

1. All meaningful user turns enter their foreground Pi-backed session. Approved
   workflows use independent persistent Pi coordinator sessions behind the same
   runtime adapter; background coordination must not depend on voice or interrupt
   ordinary chat. Do not create a hidden path that bypasses Pi.
2. Memory retrieval does not count as an execution tool. A visible `TaskRun`
   begins or continues when the Agent requests execution tools.
3. Every tool attempt produces an auditable receipt with policy, timing,
   result class and verification information.
4. `read` and `local_write` are automatic by default; external side effects
   and privileged actions require confirmation by default.
5. An uncertain external outcome is `unknown` and must be reconciled before a
   retry. Never blindly repeat a possibly-applied side effect.
6. Rust is the authority for privileged OS actions and durable local state.
7. Browser automation uses bounded Playwright tools, not arbitrary scripts
   exposed to the Agent.
8. Native desktop automation prefers Accessibility semantics, with screenshot
   and constrained low-level fallback.
9. Personality, user-authored preferences, Agent-authored memories, task
   history and execution evidence remain separate data and prompt layers.
10. User-authored personality and preference entries are read-only to the
    Agent. The Agent may append or revise only Agent-authored records permitted
    by their mutability policy.
11. RPC retries reuse the same `requestId`. Inbound durable operations may
    replay saved results for identical payload digests; outbound receipts
    record transport acknowledgement, not business success. Persist `sending`
    before writing pipe bytes, and reconcile interrupted sends before retry.
    Digest conflicts must be rejected. Realtime `voice.*` traffic is excluded
    from the durable outbound ledger; never persist audio or credentials there.

## Tool and provider boundaries

后台托管授权只能来源于真人批准的总计划；Host 每次核对意图版本、仓库、
工作区和动作范围。代理可以处理范围内细节，不能批准新增权限、push 或应用
到用户当前分支。工作目录不是沙箱。每工作流只能有一个持久协调领取者；
检查点与事件回执一起保存，可能已执行的操作不能因通信重试而重放。

后台 Pi 只能使用所属工作流的协作工具，不继承前台原生文件/shell 工具。
空事件领取不得调用模型；高频工具活动不得当作实质进展。三轮无进展或同一
问题三轮返工转 `needs_user`，不能用模型声称“有进展”绕过持久化校验。
启动阶段必须区分 `not_started`、`start_requested`、`executing`、`saved`；
重启只恢复可证明未启动的队列，未知结果保留现场，用户暂停/取消不得自启。

未知 shell 命令或无法约束的写入必须交给真人确认。只读命令使用显式白名单、
真实路径与危险选项校验；Git 读取必须关闭可能执行外部程序的功能。授权测试
使用已验证的 macOS 限制运行器，不继承云端密钥；不能仅因 cwd 正确就自动
批准任意命令。后台不播报，完成/阻塞通知基于结构化状态且去重。
Claude 子进程必须保留 `DISABLE_AUTOUPDATER=1`，避免运行期更新破坏用户 CLI；
不得自行更新 CLI。`AskUserQuestion` 使用结构化回调，未验证的计划退出协议
使用“计划产出 → 主 Pi 审查 → 明确实施工作项”，不模拟键盘批准。

Custom tools should use the shared tool contract and be registered through the
Tool Registry. The first custom capability set is:

- Browser: `browser_open`, `browser_click`, `browser_type`, `browser_extract`
- Desktop: `desktop_observe`, `desktop_click`, `desktop_type`, `desktop_key`,
  `desktop_scroll`, `desktop_focus_window`, `desktop_launch_app`
- Coding Agent: start, observe, steer, pause and cancel a local PTY-like task
- Memory: scoped search and internal memory write/management operations

The common Coding Agent terminal layer owns process lifecycle, input, output
streaming, resize and cancellation. Provider adapters own launch arguments,
authentication prompts, output parsing, steering, resume and result
collection. Do not make Pi, Claude Code or Codex special cases in the TaskRun
model.

STT, TTS and LLM are cloud-backed in the MVP, but each provider must implement
the corresponding interface and normalized streaming events. Keep credentials
out of source code and use environment variables or the macOS Keychain
integration described by the implementation.

## Development workflow

1. Read the relevant sections of `docs/DESIGN.md`, `docs/DECISIONS.md` and
   `tasks.md`.
2. Select one small task cluster and identify its acceptance evidence before
   editing.
3. Implement the smallest coherent slice. Keep changes inside the owning
   module and update shared contracts before consumers.
4. Add or update focused tests at the same time.
5. Run formatting, type checks, linting and the narrowest relevant tests.
6. Verify the behavior through the real boundary when possible: protocol
   round-trip, provider stream, Playwright fixture, PTY fixture, or macOS
   permission/action fixture.
7. Update `tasks.md` immediately after the slice is genuinely complete. Mark
   only completed checkboxes and add a short evidence note. Add the commit hash
   only after the reviewed change is committed.
8. 每个阶段子块（例如 `1B`、`1C`）完成并验证后，必须先保留未提交改动供
   用户 review。只有收到用户明确批准后，才能创建该子块的 commits 或 push；
   不得把“继续下一部分”理解为自动批准提交。
9. After review approval, make one focused commit per commit point in
   `tasks.md`. Avoid mixing
   unrelated refactors, generated caches, credentials or browser auth state.
10. Before opening a pull request or pushing, run the full applicable checks and
    review the diff for accidental secrets and unrelated files.

### Task status convention

Use these markers in `tasks.md`:

- `[ ]` planned or not started
- `[-]` in progress or blocked, with a note
- `[x]` complete and verified

Every completed task should include:

- implementation evidence, such as files or a test command;
- the verification command and result;
- the commit hash when the task is committed.

If implementation reveals a design conflict, stop and update the design or
decision log before silently changing the architecture.

## Testing expectations

At minimum, changes should cover the relevant layer:

- domain state machines and policy rules with unit tests;
- Rust/Node protocol messages with contract tests;
- provider adapters with deterministic fake streams;
- browser tools with Playwright fixtures;
- Coding Agent adapters with PTY fixtures and interrupted-process tests;
- desktop tools with guarded macOS fixtures;
- memory retrieval with scope, conflict and progressive-loading cases;
- end-to-end workflows with evidence assertions, not only screenshot checks.

Negative paths are first-class acceptance cases: permission denied, stale
targets, changed approval payloads, worker restart, network loss, duplicate
submission risk and unreconcilable `unknown` outcomes.

## Security and repository hygiene

- Never commit `.env`, API keys, cookies, browser profiles, Keychain exports,
  screenshots containing secrets, generated `target/`, `dist/` or
  `node_modules/`.
- Keep test fixtures synthetic and deterministic.
- Redact tool inputs, provider payloads and process output in logs.
- Do not widen a tool's capability merely to make a test pass.
- Do not use destructive Git commands to discard changes from other
  contributors.

## Commit style

Use focused conventional commits:

```text
feat(scope): add capability
fix(scope): correct behavior
refactor(scope): reshape internals without behavior change
test(scope): add coverage
docs(scope): update design or tasks
chore(scope): tooling or repository maintenance
```

The commit body should mention the acceptance evidence when the change affects
runtime behavior. Keep each commit buildable when practical.
