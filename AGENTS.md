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

### React and Tailwind CSS

- Use React with TypeScript. Components should receive typed props and expose
  behavior through domain callbacks.
- Use Tailwind CSS for application styling and keep shared visual tokens in a
  small theme layer rather than scattering arbitrary values.
- Prefer existing component primitives and the local design system before
  creating one-off UI patterns.
- Use Lucide icons when an icon exists. Icon-only controls need accessible
  labels and tooltips.
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

1. All meaningful user turns enter the same Pi-backed session. Do not create a
   hidden fast path that bypasses Pi.
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

## Tool and provider boundaries

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
   only completed checkboxes, add a short evidence note and record the commit
   hash after committing.
8. Make one focused commit per commit point in `tasks.md`. Avoid mixing
   unrelated refactors, generated caches, credentials or browser auth state.
9. Before opening a pull request or pushing, run the full applicable checks and
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
