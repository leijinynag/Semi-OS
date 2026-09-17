# Semi-OS MVP 开发任务清单

> 当前状态：架构基线已完成，业务实现尚未开始。
>
> 使用规则：完成一个完整的功能切片，验证通过后立即更新本文件，再创建对应提交。
> 不要因为代码已经存在就直接标记完成。

## 使用说明

- `[ ]`：计划中，尚未开始
- `[-]`：进行中或被阻塞，需要附加说明
- `[x]`：已经完成并通过验证
- 每个完成项都必须记录实现证据、验证命令和 commit hash。
- 每个 commit 点应足够小，能够独立审查、测试和回滚。
- 同一阶段内，只有依赖已经满足的任务才能并行开发。

## 完成定义

一个任务只有同时满足以下条件，才能标记为完成：

1. 实现位于设计文档规定的模块边界内。
2. 同时补充了对应的单元测试、契约测试、集成测试或端到端测试。
3. 格式化、类型检查、Lint 和相关测试全部通过。
4. 存在具体的验收证据或确定性的测试 Fixture。
5. 已更新本文件，并记录验证结果和 commit hash。

## 阶段 0：产品与架构基线

以下内容在实现工作开始前已经完成。

- [x] **P0.1 建立架构基线**
  - 证据：`docs/DESIGN.md`、架构 SVG 和产品原型图。
  - Commit：已有 `16c8c9a`，以及文档基线提交 `4b8aa16`。
- [x] **P0.2 建立决策记录**
  - 证据：`docs/DECISIONS.md` 已记录运行时、工具、语音、记忆和 MVP 决策。
  - Commit：文档基线提交 `4b8aa16`。
- [x] **P0.3 保留飞书发布源文件**
  - 证据：`docs/feishu/semi-os-design.xml` 与技术方案同步维护。
  - Commit：文档基线提交 `4b8aa16`。
- [x] **P0.4 定义 MVP 场景与验收标准**
  - 证据：`docs/DESIGN.md` 已描述资料调研、Coding Agent 和通用应用操作三类场景。
  - Commit：文档基线提交 `4b8aa16`。
- [x] **P0.5 建立项目协作规范**
  - 证据：`AGENTS.md` 已定义模块边界、代码规范、验证方式和任务更新规则。
  - Commit：文档基线提交 `4b8aa16`。

## 阶段 1：仓库与构建基础

### 1A. Workspace 初始化

依赖：无。

- [x] **P1.1 添加根目录 Workspace 配置**
  - 添加 `package.json`、`pnpm-workspace.yaml`、根 TypeScript 配置和 Workspace 脚本。
  - Commit 点：`chore(repo): bootstrap pnpm workspace`
  - 证据：`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`pnpm-lock.yaml`。
  - 验证：`pnpm install --lockfile-only`；workspace 可识别 6 个 JavaScript 项目。
  - Commit：`3317908`。
- [x] **P1.2 添加 Cargo Workspace**
  - 添加根目录 `Cargo.toml`、各 Rust Crate 清单和共享 Rust Profile 配置。
  - Commit 点：`chore(repo): bootstrap cargo workspace`
  - 证据：`Cargo.toml`、`Cargo.lock`、`crates/host`、`crates/storage`、`crates/desktop-macos`。
  - 验证：`cargo fmt --all -- --check`、`cargo check --workspace`、`cargo test --workspace`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`cargo build --workspace` 均通过。
  - Commit：`dfa249b`。
- [x] **P1.3 创建目标目录骨架**
  - 创建 `apps/desktop`、`crates/host`、`crates/storage`、
    `crates/desktop-macos`、`packages` 和 `tests` 目录，并提供最小可构建入口。
  - Commit 点：`chore(repo): scaffold Semi-OS modules`
  - 证据：桌面入口、Agent Worker、共享包、协议包、工具 SDK、Skills 包及 `tests/contract`、`tests/integration`、`tests/e2e`。
  - 验证：`pnpm run typecheck`、`pnpm run lint:js`、`pnpm run test:js`、`pnpm run build:js` 均通过；`pnpm run dev` 输出 `Semi-OS desktop shell placeholder`。
  - Commit：`baac72b`。
- [x] **P1.4 添加统一开发命令**
  - 提供统一的 `dev`、`build`、`test`、`lint`、`format`、`typecheck` 和 `check` 命令。
  - Commit 点：`chore(repo): add development command surface`
  - 证据：根目录 `package.json` 提供 JS/Rust 分层命令和统一 `check` 命令，锁定 TypeScript、Node 类型与 Rust 依赖状态。
  - 验证：`pnpm run typecheck`、`pnpm run lint:js`、`pnpm run test:js`、`pnpm run build:js`、`cargo fmt --all -- --check`、`cargo check --workspace`、`cargo test --workspace`、`cargo clippy --workspace --all-targets --all-features -- -D warnings`、`cargo build --workspace` 均通过。
  - Commit：`470c404`。

### 1B. 共享协议与类型

依赖：P1.1、P1.2、P1.3。

- [x] **P1.5 定义领域枚举与 ID**
  - 定义 `TaskId`、`TaskRunId`、`TraceId`、`RequestId`、任务生命周期、
    语音状态、工具风险等级、结果类型和能力状态。
  - Commit 点：`feat(protocol): define core domain identifiers`
  - 证据：`schemas/protocol.schema.json`、`packages/shared/src/generated/domain.generated.ts`、
    `crates/protocol/src/generated.rs`。
  - 验证：`pnpm run typecheck`、`cargo check --workspace` 均通过。
  - Commit：`0d17a19`。
- [x] **P1.6 定义版本化 JSONL 信封**
  - 定义 Rust/TypeScript 共用的请求、响应、事件和错误信封，包含
    `protocolVersion`、`requestId`、`taskId`、`kind`、`payload` 和可选 `traceId`。
  - Commit 点：`feat(protocol): define host worker envelopes`
  - 证据：`packages/protocol/src/envelope.ts`、`crates/protocol/src/lib.rs`。
  - 验证：TypeScript 与 Rust 均可序列化和反序列化一致的 camelCase 信封。
  - Commit：`195448f`。
- [x] **P1.7 从单一 Schema 生成类型**
  - 选择唯一的 Schema 来源，生成 Rust 和 TypeScript 类型，并添加兼容性 Fixture。
  - Commit 点：`feat(protocol): generate cross-runtime types`
  - 证据：`schemas/protocol.schema.json` 是单一事实来源，
    `scripts/generate-protocol.mjs` 生成 TypeScript 与 Rust 类型。
  - 验证：`pnpm run generate:protocol` 后生成文件稳定，TypeScript/Rust 构建通过。
  - Commit：`c09cc24`。
- [x] **P1.8 添加协议校验**
  - 拒绝未知协议版本和格式错误的 Payload，覆盖正常往返和典型错误响应。
  - Commit 点：`test(protocol): cover jsonl compatibility`
  - 证据：`packages/protocol/src/envelope.test.ts` 与
    `crates/protocol/src/lib.rs` 共用 `tests/contract/fixtures/request.json`。
  - 验证：Node 协议测试 3 项、Rust 协议测试 2 项通过；全仓库
    TypeScript 类型检查、Lint、测试、构建以及 Rust fmt、check、test、
    clippy、build 均通过。
  - Commit：`5c2cad1`。

### 1C. Tauri 与进程生命周期

依赖：P1.3、P1.6。

- [x] **P1.9 搭建 Tauri 桌面壳**
  - 添加客户端窗口、临时桌面助手窗口、托盘入口和开发期窗口控制能力。
  - Commit 点：`feat(desktop): scaffold tauri windows`
  - 证据：`apps/desktop` 已接入 React 19、Vite 7、Tailwind CSS 4 与
    Tauri v2；提供 `client` 客户端窗口、透明置顶且默认隐藏的 `assistant`
    窗口、系统托盘入口和 Host command 控窗。
  - 验证：`pnpm --filter @semi-os/desktop run build` 通过；
    `pnpm --filter @semi-os/desktop run tauri:dev` 可启动真实桌面壳，退出后
    无桌面进程、Vite 或 Agent Worker 残留；窗口关闭转为隐藏，PTT 显示助手
    时不主动获取焦点，客户端通过 Host 快照和事件同步助手显隐状态。
  - Commit：`e0a871b`。
- [x] **P1.10 实现 Rust Host 生命周期**
  - 添加应用启动、关闭、全局快捷键注册以及类型化的 Tauri Commands/Events。
  - Commit 点：`feat(host): add desktop lifecycle`
  - 证据：`crates/host/src/lifecycle.rs` 将 Host 生命周期与任务/Worker 状态
    分离；Tauri 注册 `CommandOrControl+Shift+Space`，发布按下/释放事件，
    并提供 `get_host_lifecycle`、`get_assistant_visibility`、
    `set_assistant_visible` 类型化 command。
  - 验证：Host 生命周期单元测试、`cargo check --workspace` 和真实 Tauri
    启动均通过；应用退出时同步停止 Worker 监督器。
  - Commit：`e0a871b`。
- [x] **P1.11 添加 Node Worker 监督器**
  - 启动 Worker，连接 JSONL stdio，发送健康事件，并使用有限退避策略重启。
  - Commit 点：`feat(host): supervise agent worker`
  - 证据：`packages/agent-worker` 实现 stdin/stdout JSONL 健康握手；
    `crates/host/src/supervisor.rs` 启动真实 Node Worker，只有收到合法
    `health.ready` 才发布 Ready；就绪后持续消费、校验并分发 Worker 消息，
    并采用最多 3 次、250ms 至 2s 的有限退避。
  - 验证：Node Worker 健康握手测试 2 项通过；Host 测试覆盖握手后的事件
    消费；真实 Tauri 启动期间 Worker 保持就绪，退出后子进程被回收。
  - Commit：`e0a871b`。
- [x] **P1.12 添加崩溃与协议诊断**
  - 持久化 Worker 退出原因、协议错误和重启次数，同时避免向 UI 暴露秘密。
  - Commit 点：`test(host): cover worker recovery`
  - 证据：`crates/host/src/diagnostics.rs` 以脱敏 JSONL 追加记录退出、协议错误
    和重启次数；UI 只接收结构化 `host://worker-event`。崩溃 Fixture 在合法
    握手后以 code 23 退出，覆盖 Ready、Exited、RestartScheduled 和重启上限。
  - 验证：`cargo test -p semi-os-host` 4 项通过；全仓库 TypeScript
    typecheck、Lint、测试、构建，以及 Rust fmt、check、test、clippy、build
    均通过。
  - Commit：`e0a871b`。

## 阶段 2：持久化任务运行时

依赖：P1.5 至 P1.12。

### 2A. SQLite 与事件模型

- [x] **P2.1 添加 SQLite Migration**
  - 创建 `tasks`、`task_events`、`agent_sessions`、`tool_attempts`、
    `approvals`、`artifacts`、`settings` 和 `capabilities` 表。
  - Commit 点：`feat(storage): add core sqlite schema`
  - 证据：`crates/storage/migrations/0001_core.sql` 创建八张核心表、
    外键、JSON/枚举约束及恢复查询索引；`src/migrations.rs` 在独占事务中
    维护 `schema_migrations`，`Storage` 初始化启用外键、WAL 与 busy timeout。
  - 验证：真实临时文件数据库首次迁移和重复打开均通过，测试直接核对八张
    核心表及迁移版本。
  - Commit：`6a629d0`。
- [x] **P2.2 实现当前快照与追加事件**
  - 在同一事务中保存当前任务投影并追加领域事件。
  - Commit 点：`feat(storage): persist task snapshots and events`
  - 证据：`crates/storage/src/repository.rs` 使用 `IMMEDIATE` 事务、
    `last_event_sequence` 乐观并发版本和每任务连续事件序号，原子更新
    `tasks` 快照并追加带投影的 `task_events`。
  - 验证：测试覆盖连续事件、陈旧快照冲突和事件唯一约束失败时的完整回滚，
    证明不会产生已推进快照或孤立事件。
  - Commit：`6406b6f`。
- [x] **P2.3 添加事件重放与恢复 Fixture**
  - 根据事件重建任务、恢复 Checkpoint，并证明已完成的工具回执不会重复执行。
  - Commit 点：`test(storage): cover task recovery`
  - 证据：`crates/storage/tests/recovery.rs` 关闭并重新打开文件数据库后，按
    事件序列重建任务投影、恢复 Pi Session Checkpoint，并通过幂等键复用成功
    回执；`started`、`unknown`、`needs_user` 尝试要求先对账，明确失败或取消
    的尝试允许进入下一次执行决策。
  - 验证：Storage 恢复测试 5 项通过；全仓库 TypeScript typecheck、Lint、
    测试、构建，以及 Rust fmt、check、test、clippy、build 均通过。
  - Commit：`e3aac55`。

### 2B. 任务生命周期与执行回执

- [ ] **P2.4 实现 TaskRun 状态机**
  - 实现 `created`、`listening`、`understanding`、`running`、`paused`、
    `waiting_confirmation`、`verifying`、`completed`、`failed`、`unknown`、
    `reconciling`、`needs_user` 和 `cancelled` 状态及其合法转换。
  - Commit 点：`feat(task): implement task lifecycle`
- [ ] **P2.5 实现领域事件总线**
  - 为 Rust、Node 和 React 统一任务、语音、工具、确认、Worker 和验证事件。
  - Commit 点：`feat(task): add domain event stream`
- [ ] **P2.6 实现工具尝试回执**
  - 记录脱敏输入、目标、策略决定、确认摘要、耗时、结果类型、验证结果和
    Artifact 引用。
  - Commit 点：`feat(tool): add execution receipts`
- [ ] **P2.7 实现验证与 `unknown` 结果**
  - 只有明确验证通过才能标记成功；不确定的操作必须暂停并进入对账流程，不允许自动重试。
  - Commit 点：`feat(task): enforce verified completion`

### 2C. 动态能力与 Pi 边界

- [ ] **P2.8 实现 Tool Registry**
  - 注册内置工具和自定义工具，支持风险等级、可用性、摘要、执行、验证和对账契约。
  - Commit 点：`feat(tool): add dynamic tool registry`
- [ ] **P2.9 实现能力发现**
  - 跟踪 Provider 健康状态、系统权限、已安装 Coding Agent、浏览器就绪状态和可用 CLI 命令。
  - Commit 点：`feat(capability): add runtime capability discovery`
- [ ] **P2.10 实现 `AgentRuntimeAdapter`**
  - 封装 Pi Session 创建、Prompt、Steer、Follow-up、Abort、工具替换、
    Checkpoint 和事件订阅。
  - Commit 点：`feat(agent): add pi runtime adapter`
- [ ] **P2.11 实现动态工具注入**
  - 根据工具目录、平台、权限、策略、工作区、运行健康状态和 Skill 要求构建当前有效工具集合。
  - Commit 点：`feat(agent): inject active tools dynamically`
- [ ] **P2.12 添加 Fake Runtime 集成测试**
  - 在不依赖外部 Provider 的情况下跑通确定性的 Prompt → Tool → Receipt 流程，
    作为第一个端到端运行时 Fixture。
  - Commit 点：`test(agent): add deterministic runtime fixture`

### 2D. 最小客户端壳

- [ ] **P2.13 构建客户端导航**
  - 添加对话、任务、记忆、Skills 和设置页面，并使用类型化的占位数据。
  - Commit 点：`feat(client): add control center navigation`
- [ ] **P2.14 构建任务时间线**
  - 展示结构化里程碑、当前动作、等待原因、结果和证据链接，不解析助手文本。
  - Commit 点：`feat(client): add task timeline`
- [ ] **P2.15 构建桌面助手界面**
  - 添加临时助手窗口、麦克风入口、确认语句以及暂停、取消、确认操作。
  - Commit 点：`feat(assistant): add floating desktop surface`

## 阶段 3：语音对话闭环

依赖：P2.4、P2.5、P2.10、P2.13 至 P2.15。

- [ ] **P3.1 定义 STT Provider 接口**
  - 统一中间转写、最终转写、静音、错误和取消事件。
  - Commit 点：`feat(voice): define stt provider contract`
- [ ] **P3.2 添加云端 STT Adapter**
  - 实现流式语音转文字，并处理 Provider 配置、超时和取消。
  - Commit 点：`feat(voice): add cloud stt adapter`
- [ ] **P3.3 定义 TTS Provider 接口**
  - 统一句子音频分片、首段音频就绪、完成、错误和取消事件。
  - Commit 点：`feat(voice): define tts provider contract`
- [ ] **P3.4 添加云端 TTS Adapter**
  - 实现按句缓冲的流式音频播放和生成任务取消。
  - Commit 点：`feat(voice): add cloud tts adapter`
- [ ] **P3.5 添加云端 LLM 配置**
  - 通过 Pi/Provider 配置使用云端 LLM，禁止 React 接触 Provider 凭证。
  - Commit 点：`feat(agent): configure cloud llm provider`
- [ ] **P3.6 实现 Push-to-talk**
  - 注册全局快捷键，按住时采集音频，并提交第一句完整语音。
  - Commit 点：`feat(voice): add push to talk`
- [ ] **P3.7 实现确定性语音确认**
  - 在较长的模型处理开始前先播报快速确认，但不能声称任务已经完成。
  - Commit 点：`feat(voice): add immediate acknowledgement`
- [ ] **P3.8 实现首句 TTS**
  - 缓冲到第一句完整回复后立即播放，后续句子排队播放。
  - Commit 点：`feat(voice): stream first sentence`
- [ ] **P3.9 实现暂停、取消、Steer 和 Follow-up**
  - 先停止语音，保留 Pi 上下文，在正确的续接位置注入新指令，并发布完整生命周期事件。
  - Commit 点：`feat(voice): support interruption and steering`
- [ ] **P3.10 语音闭环验收**
  - 使用录音或 Fake Audio Fixture 验证按住说话、快速确认、普通对话、中途打断和同一会话继续执行。
  - Commit 点：`test(voice): verify conversation loop`

## 阶段 4A：资料调研工作流

依赖：P2.6 至 P2.12、P3.7 至 P3.10。

- [ ] **P4A.1 添加 Playwright 服务边界**
  - 从 Worker 启动受控浏览器进程，返回结构化观察结果，不向 Agent 暴露任意 Playwright 脚本执行能力。
  - Commit 点：`feat(browser): add playwright service`
- [ ] **P4A.2 添加持久化浏览器 Profile 初始化**
  - 创建 Semi-OS 专属 Profile 目录，支持用户交互登录，并确保认证状态不进入 Git 和日志。
  - Commit 点：`feat(browser): add profile onboarding`
- [ ] **P4A.3 实现 `browser_open`**
  - 返回页面身份、URL、标题、加载状态和观察版本。
  - Commit 点：`feat(browser): add browser open`
- [ ] **P4A.4 实现 `browser_click`**
  - 优先使用 role、name、label、text 定位；拒绝过期观察引用，并在动作后返回新的观察结果。
  - Commit 点：`feat(browser): add browser click`
- [ ] **P4A.5 实现 `browser_type`**
  - 支持受约束的文本输入、目标验证和动作后的新状态。
  - Commit 点：`feat(browser): add browser type`
- [ ] **P4A.6 实现 `browser_extract`**
  - 提取可读内容、页面元数据和来源 URL，并保存为 Artifact。
  - Commit 点：`feat(browser): add browser extract`
- [ ] **P4A.7 添加资料来源证据模型**
  - 保存访问来源、提取事实、被阻止/失败来源和 Artifact 摘要。
  - Commit 点：`feat(research): record source evidence`
- [ ] **P4A.8 添加资料调研 Skill**
  - 添加多来源搜索、事实比较、不确定性记录和避免无依据结论的内置指导。
  - Commit 点：`feat(research): add research skill`
- [ ] **P4A.9 添加调研汇总与语音汇报**
  - 生成带来源的简洁汇总，在第一句完整结果后启动 TTS，并在客户端展示来源列表。
  - Commit 点：`feat(research): add sourced voice briefing`
- [ ] **P4A.10 资料调研验收**
  - 通过确定性的多站点 Fixture 和一个被阻止来源 Fixture，验证 Artifact、时间线、汇总结果和最终语音响应。
  - Commit 点：`test(research): verify research workflow`

## 阶段 4B：Coding Agent 工作流

依赖：P2.4 至 P2.12、P3.7 至 P3.10。

- [ ] **P4B.1 定义 `CodingAgentProvider`**
  - 定义仓库、目标、约束、启动、观察、Steer、暂停、取消、恢复和结果收集契约。
  - Commit 点：`feat(coding): define provider contract`
- [ ] **P4B.2 实现通用 PTY 类终端层**
  - 负责进程生命周期、stdin、stdout/stderr 流式输出、终端尺寸、退出、取消和有界输出缓冲。
  - Commit 点：`feat(coding): add pty terminal adapter`
- [ ] **P4B.3 添加 Provider 启动配置**
  - 为 Pi、Claude Code 和 Codex 添加可配置的启动 Profile，不在 TaskRun 模型中写死三者差异。
  - Commit 点：`feat(coding): add local agent launch profiles`
- [ ] **P4B.4 统一输出与里程碑**
  - 将终端输出归一化为进度里程碑、交互提示、变更文件摘要、警告和完成信号。
  - Commit 点：`feat(coding): normalize agent progress`
- [ ] **P4B.5 添加 Coding Agent 工具**
  - 通过 Tool Registry 暴露启动、观察、Steer、暂停和取消操作。
  - Commit 点：`feat(coding): expose coding agent tools`
- [ ] **P4B.6 添加仓库结果验证**
  - 收集仓库身份、Diff、变更文件、诊断、测试输出和子 Agent 退出状态作为证据。
  - Commit 点：`feat(coding): verify delegated work`
- [ ] **P4B.7 添加重启与中断恢复**
  - 保留子 Agent 回执，避免重复已完成工作，并明确表达不确定的进程结果。
  - Commit 点：`feat(coding): recover interrupted agent tasks`
- [ ] **P4B.8 Coding Agent 验收**
  - 使用本地 Coding Agent 完成一次合成仓库需求，中途 Steer 一次，检查进度并验证最终 Diff 和测试结果。
  - Commit 点：`test(coding): verify delegated coding workflow`

## 阶段 4C：原生桌面与 Lark 工作流

依赖：P2.4 至 P2.12、P3.7 至 P3.10。

- [ ] **P4C.1 添加 macOS 权限能力检查**
  - 检测麦克风、Accessibility 和 Screen Recording 权限；权限不足时只降级相关能力，不让应用崩溃。
  - Commit 点：`feat(macos): add permission capability checks`
- [ ] **P4C.2 添加 Accessibility 观察**
  - 观察前台应用、窗口身份和语义控件，并附带观察版本。
  - Commit 点：`feat(desktop): add accessibility observation`
- [ ] **P4C.3 添加原子桌面动作**
  - 实现点击、输入、按键、滚动、聚焦窗口和启动应用，并遵循重新观察和 Host 验证。
  - Commit 点：`feat(desktop): add atomic desktop actions`
- [ ] **P4C.4 添加受约束的视觉回退**
  - 只有在语义信息不足时使用截图和受限的低层输入；拒绝过期或歧义目标。
  - Commit 点：`feat(desktop): add visual fallback`
- [ ] **P4C.5 添加 Lark CLI 能力适配器**
  - 检测已安装 CLI，只通过注册表暴露稳定命令，并沿用统一工具和回执契约。
  - Commit 点：`feat(lark): add cli capability adapter`
- [ ] **P4C.6 添加通用应用工作流**
  - 启动或聚焦应用，观察状态，执行一个操作，再次观察并汇报验证结果。
  - Commit 点：`feat(desktop): add generic application workflow`
- [ ] **P4C.7 添加桌面恢复用例**
  - 覆盖权限拒绝、目标过期、应用关闭、Worker 重启和动作结果不确定等情况。
  - Commit 点：`test(desktop): verify native workflow recovery`

## 阶段 5：记忆、人格与用户偏好

依赖：P2.1 至 P2.7、P2.13 至 P2.15。可与阶段 4 并行。

- [ ] **P5.1 添加六层记忆 Schema**
  - 添加 L0 工作上下文、L1 常驻规则、L2 整理记忆、L3 情节摘要、
    L4 历史证据和 L5 程序性候选，同时保存来源和关系。
  - Commit 点：`feat(memory): add six layer schema`
- [ ] **P5.2 添加作者与可变更权限**
  - 区分用户创建、Agent 创建和系统创建的记录；拒绝 Agent 修改用户创建的人格与偏好记录。
  - Commit 点：`feat(memory): enforce memory ownership`
- [ ] **P5.3 添加自动记忆写入流水线**
  - 从对话、纠正和验证结果提取候选记忆，过滤秘密、噪音和无依据的身份推断，执行去重并关联冲突。
  - Commit 点：`feat(memory): add automatic memory writes`
- [ ] **P5.4 添加全文范围检索**
  - 先按用户、工作区、应用、任务和 Skill 过滤，再排序记忆候选并附带来源。
  - Commit 点：`feat(memory): add scoped retrieval`
- [ ] **P5.5 添加渐进式记忆加载**
  - 先加载紧凑基础包，再按需加载上下文记忆、搜索结果、深层证据和选中的程序性内容，并受 Token Budget 限制。
  - Commit 点：`feat(memory): add progressive loading`
- [ ] **P5.6 添加简单 Pi Session 压缩**
  - 在达到阈值后压缩，并保留目标、约束、决定、回执、待办动作、`unknown` 结果和最新 Steering。
  - Commit 点：`feat(memory): add session compaction`
- [ ] **P5.7 添加人格配置**
  - 添加独立的人格上下文，支持身份、语气、详略、主动程度、行为、工具和语音偏好。
  - Commit 点：`feat(personality): add runtime personality`
- [ ] **P5.8 添加客户端记忆与偏好控制**
  - 允许用户创建、编辑和删除自己的偏好，查看 Agent 创建的记忆，并展示每条记录的归属。
  - Commit 点：`feat(client): add memory controls`
- [ ] **P5.9 记忆验收评估**
  - 验证相关记忆召回、无关记忆排除、纠正处理、压缩后上下文连续性和用户记录不可被 Agent 修改。
  - Commit 点：`test(memory): verify useful recall`

## 阶段 6：统一交互与可观测性

依赖：阶段 4A、4B、4C 至少各完成一条代表性工作流。

- [ ] **P6.1 添加桌面助手视觉系统**
  - 实现鼠标跟随、粒子、声波响应和减少动效支持；动效不能与业务状态耦合。
  - Commit 点：`feat(assistant): add ambient visual effects`
- [ ] **P6.2 完善任务进度展示**
  - 展示里程碑、当前动作、确认请求、等待原因、失败、`unknown` 结果和证据链接。
  - Commit 点：`feat(client): improve task progress`
- [ ] **P6.3 添加语音和任务 Telemetry**
  - 记录 Trace ID，以及 STT、LLM 首 Token、首句、TTS 首段音频、工具执行、验证和恢复阶段耗时。
  - Commit 点：`feat(observability): add task latency telemetry`
- [ ] **P6.4 添加诊断导出**
  - 允许用户主动导出脱敏诊断包，并在导出前预览包含的数据。
  - Commit 点：`feat(observability): add redacted diagnostics`
- [ ] **P6.5 统一中断行为**
  - 在资料调研、Coding Agent 和桌面操作中测试语音中断，并验证 Agent 对 Steer、暂停、取消和新任务的判断。
  - Commit 点：`test(task): verify cross-workflow interruption`

## 阶段 7：恢复、安全与发布准备

依赖：阶段 1 至阶段 6。

- [ ] **P7.1 建立网络故障矩阵**
  - 测试模型响应前、TTS 过程中、浏览器读取过程中、Coding Agent 执行中以及外部副作用前后的网络故障。
  - Commit 点：`test(recovery): cover network failure matrix`
- [ ] **P7.2 建立 Worker 崩溃矩阵**
  - 在各生命周期阶段杀掉 Worker，验证 Checkpoint 恢复、回执保留和不重复执行。
  - Commit 点：`test(recovery): cover worker crash matrix`
- [ ] **P7.3 添加确认与策略测试**
  - 测试默认风险等级、设置覆盖、确认 Payload 变化和特权操作。
  - Commit 点：`test(policy): cover confirmation boundaries`
- [ ] **P7.4 执行秘密与 Profile 清理审计**
  - 检查 Git 历史和构建产物中是否存在凭证、Cookie、本地 Profile、原始音频和未脱敏诊断数据。
  - Commit 点：`chore(security): audit repository hygiene`
- [ ] **P7.5 添加跨平台构建检查**
  - 保持 macOS 原生控制能力受平台保护，同时确保桌面壳和 Provider 抽象在支持的平台上正常构建。
  - Commit 点：`ci(build): add platform build checks`
- [ ] **P7.6 添加 CI**
  - 运行格式化、Lint、TypeScript 检查、Rust 检查、单元测试、契约测试和确定性集成 Fixture。
  - Commit 点：`ci(repo): add continuous integration`
- [ ] **P7.7 添加发布打包配置**
  - 配置应用元数据、签名/更新器占位、权限说明、Provider 设置和首次启动能力检查。
  - Commit 点：`chore(release): prepare desktop packaging`
- [ ] **P7.8 MVP 发布门禁**
  - 端到端运行三类验收工作流，记录证据，并在本文件中更新发布 commit 和已知限制。
  - Commit 点：`chore(release): close MVP gate`

## MVP 之后暂缓

- [ ] 唤醒词和自动检测说话结束。
- [ ] 微信专用适配器和消息工作流。
- [ ] 第三方 Skill/插件市场。
- [ ] MCP 生态集成。
- [ ] Windows 和 Linux 原生自动化。
- [ ] 远程执行和多设备控制。
- [ ] Dream Cycle、图记忆、复杂衰减和自动 Skill 晋升。
- [ ] 完全本地化的 STT、TTS 和 LLM Provider 组合。
