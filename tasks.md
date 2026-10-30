# Semi-OS MVP 开发任务清单

> 当前状态：4A、4B 及后台托管优化已提交；语音优化、Ego Lite 续接和 4C 桌面能力已获用户批准提交，提交记录见下文。完整原生与故障联调待验收，不因提交而视为完成。
>
> 使用规则：完成一个功能切片并验证后更新本文件，保留未提交改动供 review；
> 只有用户明确批准后才创建提交或 push。
> 不要因为代码已经存在就直接标记完成。

## 使用说明

- `[ ]`：计划中，尚未开始
- `[-]`：进行中或被阻塞，需要附加说明
- `[x]`：已经完成并通过验证
- 每个完成项都必须记录实现证据、验证命令和 commit hash。
- 每个 commit 点应足够小，能够独立审查、测试和回滚。
- 同一阶段内，只有依赖已经满足的任务才能并行开发。

## 本次提交记录（2026-10-30）

用户已明确批准提交和 push。下文历史记录中的“未提交 / 等待 review”
描述保留为当时状态；本次纳入的改动以以下提交记录为准：

- `40ab880`：桌面与浏览器接管协议、CSP 安全的生成校验器及可空响应修复。
- `bfe3e32`：语音采集、播放同步、云端适配器与延迟诊断优化。
- `94f9c01`：Ego Lite 默认后端及同 Space 续接、原生桌面与飞书工具、
  客户端控制、签名配置、Node 查找和辅助功能观察恢复。
- 验证：本次提交前重新运行 `pnpm check`，格式、协议生成、类型检查、
  Lint、Rust 检查、测试、构建与 `git diff --check` 全部通过。
  121 个变更文件的敏感模式扫描未发现凭证或误入的生成产物。
- 已有 `14f5e51` 包含 4B 及后台托管相关改动；原生业务动作、真人语音质量、
  视觉回退、独立 Worker 打包与故障联调仍按各节保留未完成状态。

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

- [x] **P2.4 实现 TaskRun 状态机**
  - 实现 `created`、`listening`、`understanding`、`running`、`paused`、
    `waiting_confirmation`、`verifying`、`completed`、`failed`、`unknown`、
    `reconciling`、`needs_user` 和 `cancelled` 状态及其合法转换。
  - Commit 点：`feat(task): implement task lifecycle`
  - 证据：`crates/host/src/task.rs` 定义纯 `TaskStateMachine` 和 Rust Host
    权威入口 `TaskRuntime`；每次转换先校验合法性，再在 SQLite 事务中同步
    更新快照并追加事件，成功提交后才向订阅者广播。
  - 验证：测试覆盖合法转换、终态保护、暂停/恢复路径，以及 `unknown` 不能
    直接回到 `running`、必须先进入 `reconciling`。
  - Commit：`937fffe`。
- [x] **P2.5 实现领域事件总线**
  - 为 Rust、Node 和 React 统一任务、语音、工具、确认、Worker 和验证事件。
  - Commit 点：`feat(task): add domain event stream`
  - 证据：`crates/protocol/src/domain.rs` 与
    `packages/shared/src/domain-events.ts` 提供同构判别联合，覆盖任务生命周期/
    进度、语音、工具、确认、Worker、验证和任务结果；Schema 统一生成相关枚举，
    TypeScript 入口提供运行时校验。
  - 验证：Rust 与 TypeScript 读取同一
    `tests/contract/fixtures/domain-event.json`，锁定事件名称和字段结构；非法或
    不完整事件会在 TypeScript 边界被拒绝。
  - Commit：`f7256a9`。
- [x] **P2.6 实现工具尝试回执**
  - 记录脱敏输入、目标、策略决定、确认摘要、耗时、结果类型、验证结果和
    Artifact 引用。
  - Commit 点：`feat(tool): add execution receipts`
  - 证据：`ToolExecutionReceipt` 在 Rust 与 TypeScript 中记录脱敏输入摘要/
    摘要值、目标、风险、策略决定、审批绑定、开始/结束时间、耗时、结构化结果、
    验证证据、Artifact 和幂等键；Host 将完整领域回执映射到现有 SQLite 投影。
  - 验证：测试覆盖完整成功回执持久化与重启后复用，存储查询字段和完整
    `receipt_json` 保持分层。
  - Commit：`165e0b5`。
- [x] **P2.7 实现验证与 `unknown` 结果**
  - 只有明确验证通过才能标记成功；不确定的操作必须暂停并进入对账流程，不允许自动重试。
  - Commit 点：`feat(task): enforce verified completion`
  - 证据：任务完成必须通过 `complete_verified` 并携带非模型、可复查证据；
    工具成功回执必须同时满足 `succeeded`、`success` 和 `passed`。恢复入口对
    `started`、`unknown`、`needs_user` 返回 `Reconcile`，不会返回执行许可。
  - 验证：负向测试覆盖缺少验证、仅凭模型文字宣称成功、结果字段矛盾，以及
    `unknown` 尝试重启后禁止直接重试；全仓库 Rust fmt/check/test/clippy/build
    和 TypeScript typecheck/lint/test/build 均通过。
  - Commit：`937fffe`、`165e0b5`。任务终态校验位于 TaskRuntime，工具结果
    一致性与恢复决策位于执行回执边界，因此由两个可独立审阅的真实提交共同完成。

### 2C. 动态能力与 Pi 边界

- [x] **P2.8 实现 Tool Registry**
  - 注册内置工具和自定义工具，支持风险等级、可用性、摘要、执行、验证和对账契约。
  - Commit 点：`feat(tool): add dynamic tool registry`
  - 证据：`packages/tool-sdk/src/tool.ts` 定义与 Pi 解耦的执行、验证和对账契约；
    `registry.ts` 分离工具注册与激活，并按平台、能力、策略、风险、工作区、
    Runtime 健康和 Skill 要求筛选。
  - 验证：Tool SDK typecheck 和 3 项单元测试通过；全仓库 TypeScript 与 Rust
    检查通过。
  - Commit：`4bbb828`。
- [x] **P2.9 实现能力发现**
  - 跟踪 Provider 健康状态、系统权限、已安装 Coding Agent、浏览器就绪状态和可用 CLI 命令。
  - Commit 点：`feat(capability): add runtime capability discovery`
  - 证据：`packages/agent-worker/src/capabilities.ts` 探测平台、Playwright、Pi、
    Claude Code、Codex 和 Lark CLI，并支持注入 Provider/Host 自定义探针；
    特权权限明确由 Rust Host 提供，不由 Worker 自行推断。
  - 验证：能力发现成功与探针失败隔离测试通过。
  - Commit：`4bbb828`。
- [x] **P2.10 实现 `AgentRuntimeAdapter`**
  - 封装 Pi Session 创建、Prompt、Steer、Follow-up、Abort、工具替换、
    Checkpoint 和事件订阅。
  - Commit 点：`feat(agent): add pi runtime adapter`
  - 证据：`runtime.ts` 提供稳定产品接口；`pi-runtime.ts` 是唯一 Pi 适配层，
    映射 Session 生命周期和事件，并将产品工具转换为 Pi 自定义工具。Pi 原生
    `read/bash/edit/write` 保持为基线工具，但通过官方 Extension Hook 统一进入
    Semi-OS 策略与回执边界；未分类 `bash` 保守按高风险处理。Checkpoint 保存并
    恢复精确的 Pi JSONL Session 文件，不再只恢复产品序号。
  - 验证：Pi SDK 真实导入成功；适配器方法、原生/自定义工具策略、异常回执、
    持久化 Session 恢复及未注册工具拒绝测试通过。
  - Commit：`4bbb828`。
- [x] **P2.11 实现动态工具注入**
  - 根据工具目录、平台、权限、策略、工作区、运行健康状态和 Skill 要求构建当前有效工具集合。
  - Commit 点：`feat(agent): inject active tools dynamically`
  - 证据：`active-tools.ts` 用同一 Registry 快照构建并应用有效工具集合；Pi
    会话仅切换启动时已注册的工具，新增工具定义必须重建会话，避免静默失效。
  - 验证：集成测试证明无权限工具不会注入 Runtime。
  - Commit：`4bbb828`。
- [x] **P2.12 添加 Fake Runtime 集成测试**
  - 在不依赖外部 Provider 的情况下跑通确定性的 Prompt → Tool → Receipt 流程，
    作为第一个端到端运行时 Fixture。
  - Commit 点：`test(agent): add deterministic runtime fixture`
  - 证据：`fake-runtime.ts` 与真实 Pi 共用 `AgentRuntimeAdapter`，并与 Pi
    自定义工具共用 `tool-execution.ts` 的执行、验证和异常回执语义；集成测试
    覆盖 Prompt → Tool → Verification → Receipt、已验证成功、异常后的
    `failed/unknown` 回执和 Checkpoint 推进。
  - 验证：Agent Worker 13 项测试全部通过；全仓库 TypeScript
    typecheck/lint/test/build，以及 Rust fmt/check/test/clippy/build 均通过。
  - Commit：`b2b8140 feat(ui): build client and assistant surfaces`

### 2D. 最小客户端壳

- [x] **P2.13 构建客户端导航**
  - 添加对话、任务、记忆、Skills 和设置页面，并使用类型化的占位数据。
  - Commit 点：`feat(client): add control center navigation`
  - 证据：`ClientSurface.tsx` 实现无导航的单一工作台，以档案时间轴、
    会议文档、证据检查器和确认输入条组织当前任务；React 只维护预览交互并
    向 Rust Host 提交助手窗口显隐意图。
  - 验证：Playwright 已验证档案与证据选择、待办勾选、写入确认及窄屏布局；
    客户端使用实时液态玻璃层和独立环境底图，而不是将原型截图作为界面。
  - Commit：`b2b8140 feat(ui): build client and assistant surfaces`
- [x] **P2.14 构建任务时间线**
  - 展示结构化里程碑、当前动作、等待原因、结果和证据链接，不解析助手文本。
  - Commit 点：`feat(client): add task timeline`
  - 证据：`TaskTimeline.tsx` 只消费 `TaskTimelineModel` 的结构化字段，
    覆盖执行中、等待确认和已完成任务，以及当前动作、等待原因、结果、
    里程碑和证据引用；页面不解析助手自然语言来推断任务状态。
  - 验证：Playwright 已验证任务切换、等待原因与窄屏时间线布局；
    TypeScript typecheck 和 Vite build 通过。
  - Commit：`b2b8140 feat(ui): build client and assistant surfaces`
- [x] **P2.15 构建桌面助手界面**
  - 添加临时助手窗口、麦克风入口、确认语句以及暂停、取消、确认操作。
  - Commit 点：`feat(assistant): add floating desktop surface`
  - 证据：`AssistantSurface.tsx` 提供六种类型化预览状态；
    `HaloScene.tsx` 使用 React Three Fiber 构建会响应指针与状态的粒子光环，
    常态不显示麦克风或关闭按钮，仅在需要确认时出现操作层。
  - 验证：助手窗口扩大为 720×520，Playwright 已确认 WebGL 画布可见、
    聆听状态与确认状态可渲染，浏览器控制台无错误。
  - 视觉迭代（2026-09-20）：`HaloScene.tsx` 与 `halo-shaders.ts` 改为共享
    参数曲面的折叠光带、细丝和 9,200 个沿流线运动的粒子，替换独立旋转的
    扁球；增加珠白、冰蓝、淡紫和香槟反射。指针在整个容器上连续采样，
    有界阻尼跟随，移出/失焦归位；动画使用积分时间平滑改变速度，
    支持减少动态效果与后台暂停。原有背景暂留，未接入真实语音振幅。
  - 本轮验证：Playwright 在 720×520、390×650、1536×1024 下读取 WebGL
    像素，确认非空、跨帧变化及主体未裁切；验证左右指针响应、移出归位、
    减少动态效果下像素不变、六种预览状态，以及确认/暂不切换状态。
    确认栏与字幕间隔 22px，无页面或 Shader 错误；保留 R3F 内部
    `THREE.Clock` 弃用警告。typecheck、lint、build、diff 检查通过；
    desktop test 脚本当前没有单元测试，不能据此声称单测覆盖。
    仍需原生 WKWebView 的 GPU 性能与材质观感验收，未宣称与原型完全一致。
  - Commit：待 review 后提交。

## 阶段 3：语音对话闭环

依赖：P2.4、P2.5、P2.10、P2.13 至 P2.15。

- [x] **P3.1 定义 STT Provider 接口**
  - 统一中间转写、最终转写、静音、错误和取消事件。
  - Commit 点：`feat(voice): define stt provider contract`
- [x] **P3.2 添加云端 STT Adapter**
  - 实现流式语音转文字，并处理 Provider 配置、超时和取消。
  - Commit 点：`feat(voice): add cloud stt adapter`
- [x] **P3.3 定义 TTS Provider 接口**
  - 统一句子音频分片、首段音频就绪、完成、错误和取消事件。
  - Commit 点：`feat(voice): define tts provider contract`
- [x] **P3.4 添加云端 TTS Adapter**
  - 实现按句缓冲的流式音频播放和生成任务取消。
  - Commit 点：`feat(voice): add cloud tts adapter`
- [x] **P3.5 添加云端 LLM 配置**
  - 通过 Pi/Provider 配置使用云端 LLM，禁止 React 接触 Provider 凭证。
  - Commit 点：`feat(agent): configure cloud llm provider`
- [x] **P3.6 实现 Push-to-talk**
  - 注册全局快捷键，按住时采集音频，并提交第一句完整语音。
  - Commit 点：`feat(voice): add push to talk`
- [x] **P3.7 实现确定性语音确认**
  - 在较长的模型处理开始前先播报快速确认，但不能声称任务已经完成。
  - Commit 点：`feat(voice): add immediate acknowledgement`
- [x] **P3.8 实现首句 TTS**
  - 缓冲到第一句完整回复后立即播放，后续句子排队播放。
  - Commit 点：`feat(voice): stream first sentence`
- [x] **P3.9 实现暂停、取消、Steer 和 Follow-up**
  - 先停止语音，保留 Pi 上下文，在正确的续接位置注入新指令，并发布完整生命周期事件。
  - Commit 点：`feat(voice): support interruption and steering`
- [x] **P3.10 语音闭环验收**
  - 使用录音或 Fake Audio Fixture 验证按住说话、快速确认、普通对话、中途打断和同一会话继续执行。
  - Commit 点：`test(voice): verify conversation loop`
  - 实现证据（2026-09-20）：
    - `packages/protocol/src/voice.ts` 定义并校验录音、提交、中断和语音事件协议；
      `crates/host/src/supervisor.rs` 保持 Worker stdin 长连接，并在启动/重启期间
      有序缓存请求。
    - `packages/agent-worker/src/voice/` 提供 STT/TTS 稳定接口、DashScope AOQ
      WebSocket Adapter、超时/取消、句子缓冲、确定性确认语和 generation gate；
      `worker-service.ts` 把录音提交到同一个 `PiAgentRuntime` Session。
    - `apps/desktop/src/voice/` 完成 16 kHz 单声道 PCM16 分片录音、有序发送、流式播放、
      快速点按竞态处理和打断先停播；Rust Host 注册
      `CommandOrControl+Shift+Space`，并通过 Tauri 事件驱动桌面助手。
    - macOS `Info.plist` 已声明麦克风用途；云端 LLM 通过 Pi 官方模型目录选择，
      DashScope Key 从根目录 `.env` 进入 Worker，不进入 React 或协议。
  - 验证证据：
    - Agent Worker 35 个测试通过，包含云端 Adapter 归一化/取消/脱敏、
      Pi 模型注入、Worker 中断、初始化期间取消、迟到 Runtime 事件隔离，
      以及贯穿 Worker → Fake STT → 同一 Runtime Session → 确认语 →
      首句 TTS → 完成事件的闭环测试。
    - Desktop 4 个测试通过，验证 PCM16 转换/重采样、按句排队、
      上一句播放结束后切换，以及用户中断时清空待播队列。
    - Protocol 6 个测试、Rust workspace 20 个测试通过；全 workspace
      typecheck、lint、build、`cargo fmt`、Clippy `-D warnings` 和
      `git diff --check` 通过。
    - 使用 `SEMI_OS_VOICE_FIXTURE_TRANSCRIPT` 启动原生 Tauri 壳层，
      `semi-os-desktop` 与 Node Agent Worker 均持续存活，随后已主动关闭。
    - 尚未使用真实云端凭证验证供应商网络、计费、音色和延迟，也未把
      macOS 麦克风权限弹窗及真实录音质量标记为已验证；这些需要 review 后
      在本机 Provider 配置下补充端到端体验验收。
  - Commit：`ca3d187`（阶段 3 作为一个可独立验收的完整语音闭环提交）。

## 阶段 4A：资料调研工作流

依赖：P2.6 至 P2.12、P3.7 至 P3.10。

实施记录：2026-10-11 用户批准提交 4A 及后续相关语音、文字对话和 Session
改动。这些切片共享协议与入口文件，本次合并为一个可构建的交付提交；
下面的 Commit 点保留为原拆分设计，不代表各自已有独立提交。
本次重新运行 `pnpm run check`、`pnpm run format` 与 `git diff --check` 均通过。
交付 Commit：`b2ab28e`，覆盖 P4A.1–P4A.10 及下面已完成的相关语音、
文字对话、客户端和 Session 切片。下文原“未提交”说明保留作历史记录，
其当前提交状态统一以本条为准。4B 当前状态见对应阶段记录。
详细证据、延迟和手动验收边界见 `docs/4A-VALIDATION.md`。

- [x] **P4A.1 添加 Playwright 服务边界**
  - 从 Worker 启动受控浏览器进程，返回结构化观察结果，不向 Agent 暴露任意 Playwright 脚本执行能力。
  - 验证：`browser/browser-service.ts` 与测试覆盖按需启动、每页串行、全局两个执行槽和取消清理。
  - Commit 点：`feat(browser): add playwright service`
- [x] **P4A.2 添加持久化浏览器 Profile 初始化**
  - 创建 Semi-OS 专属 Profile 目录，支持用户交互登录，并确保认证状态不进入 Git 和日志。
  - 验证：持久化上下文重开后保留 Fixture 登录 Cookie；客户端提供登录入口。真实网站人工登录尚需体验验收。
  - Commit 点：`feat(browser): add profile onboarding`
- [x] **P4A.3 实现 `browser_open`**
  - 返回页面身份、URL、标题、加载状态和观察版本。
  - 验证：Fixture 重定向、加载失败与登录限制；真实访问 Playwright/Vitest 官网。
  - Commit 点：`feat(browser): add browser open`
- [x] **P4A.4 实现 `browser_click`**
  - 优先使用 role、name、label、text 定位；拒绝过期观察引用，并在动作后返回新的观察结果。
  - 验证：重复目标、过期引用、搜索提交与伪装成搜索的副作用动作；授权绑定输入摘要及观察版本。
  - Commit 点：`feat(browser): add browser click`
- [x] **P4A.5 实现 `browser_type`**
  - 支持受约束的文本输入、目标验证和动作后的新状态。
  - 验证：明确输入框填入、默认不提交，搜索提交必须独立点击。
  - Commit 点：`feat(browser): add browser type`
- [x] **P4A.6 实现 `browser_extract`**
  - 提取可读内容、页面元数据和来源 URL，并保存为 Artifact。
  - 验证：延迟正文、分段/截断、同版本缓存、取消；完整正文仅经 Host 保存，Pi 接收当前片段。
  - Commit 点：`feat(browser): add browser extract`
- [x] **P4A.7 添加资料来源证据模型**
  - 保存访问来源、提取事实、被阻止/失败来源和 Artifact 摘要。
  - 验证：`0002_research.sql`、Host 测试和云端桥接 SQLite；拒绝不存在的来源/引用及不匹配的正文摘要。
  - Commit 点：`feat(research): record source evidence`
- [x] **P4A.8 添加资料调研 Skill**
  - 添加多来源搜索、事实比较、不确定性记录和避免无依据结论的内置指导。
  - 验证：内置 `research/SKILL.md` 经 Pi 官方 ResourceLoader 加载，详情按需读取；没有独立 Skill 引擎。
  - Commit 点：`feat(research): add research skill`
- [x] **P4A.9 添加调研汇总与语音汇报**
  - 生成带来源的简洁汇总，在第一句完整结果后启动 TTS，并在客户端展示来源列表。
  - 验证：即时回应、动作提示、按句结论 TTS、分块 speech 标记测试；真实来源/报告/Artifact 与排队确认 UI。
  - Commit 点：`feat(research): add sourced voice briefing`
- [x] **P4A.10 资料调研验收**
  - 通过确定性的多站点 Fixture 和一个被阻止来源 Fixture，验证 Artifact、时间线、汇总结果和最终语音响应。
  - 验证：Fake LLM/STT/TTS + Playwright 闭环、真实云 STT/DeepSeek/TTS 两站闭环、Host 引用与状态持久化、客户端交互截图。
  - 完整检查：`pnpm check`、`cargo fmt --all -- --check`、`git diff --check`；真实麦克风录音和扬声器播放仍留作人工体验验收，不宣称已完成。
  - Commit 点：`test(research): verify research workflow`

## 桌面助手与语音交互优化

- [x] **PV.15 长口语摘要自然停顿切分**
  - 显式 speech 摘要累计至少 18 汉字后，可在中文逗号/分号提前进入 TTS；
    短句、英文、冒号、引号/括号内部及结构内容不启用软切分。
  - `sentence-buffer` 与 VoiceLoop 回归覆盖跨 delta、报告隔离及取消；
    18 项定向测试通过；`pnpm check`（Worker 64 项）、Rust 格式检查和
    `git diff --check` 通过，真人端到端延迟待复测。
  - 保留 STT、Pi 和已确认有声的 WAV 出口，不增加固定回应。
  - Commit 点：`perf(voice): synthesize long speech at natural pauses`，未提交。

- [x] **PV.14 TTS 连接预热与延迟分段**
  - 参考本地 LumiCore 首句预合成；Semi-OS 已具备首句与模型生成重叠，
    本轮增加录音期间仅握手的可选 Provider 预热，15 秒过期/取消清理，
    首句领取一次，不提前生成音频、不更换播放出口。
  - 补齐 `tts.answer.completed`，区分首包与媒体可播放时间。
  - 验证：预热不发 run-task、重复预热只建一个连接、领取后取消隔离、
    未领取取消后新建连接的确定性回归；云端实测见验收文档。
  - Commit 点：`perf(voice): overlap TTS handshake with recording`，未提交。

- [-] **PV.13 空回答终态与原生无声复查**
  - 历史方案：直接媒体出口继续保留；“没有音量分析”已由 PV.19 的
    本地 PCM 包络替代，不将音频接回旧 WebAudio 输出链路。
  - 第二次真人复测仍无声，改用每句 PCM 封装 WAV 的直接媒体出口，
    不接回 WebAudio；桌面 26 项测试通过。暂时按句等待合成且没有
    音量分析；用户已确认有声音，首音延迟仍在继续优化。
  - Pi Session 证据显示“星期几啊”以 `aborted` 结束；Adapter 现在区分中止、
    失败与自动重试，空回答明确报错，不再当作正常完成。
  - 增加 Semi-OS 语音身份提示，避免模型误称纯文字助手；录音与播放
    隔离 AudioContext，保留各自复用及唯一播放控制器。
  - 真实 TTS 返回 115542 bytes、2620 ms，RMS 0.0871、峰值 0.6355；
    先前原生日志确认音频到达、时钟推进和非零分析信号。
    这些证据不能证明扬声器实际出声，无声根因仍未确认，待真人复测。
  - 验证：`pnpm check` 通过；补充上下文隔离测试后桌面 25 项测试通过，
    `git diff --check` 通过；已重启原生客户端和 Worker，未提交。

- [-] **PV.11 排查仅有文字、无声的播放问题**
  - 历史方案：借用播放上下文的做法已撤回；当前使用独立采集上下文，
    播放采用直接媒体出口，见 PV.13 / PV.19。
  - 10 月 8 日再次反馈无声：新增 Host `diagnostics/playback.jsonl` 数值诊断，
    记录音频首包、播放状态、时钟与音量，不保存正文/声音；补齐 running
    但时钟停滞的失败检测。24 项桌面回归与类型检查通过，根因仍待原生复现。
  - 实际云端 Worker 探测收到 270878 bytes 回复音频，所有语音事件通过协议校验；
    系统未静音。尚未据此判定原生扬声器播放正常。
  - 采集借用播放器的 AudioContext；PCM 到达或播放暂停时自动恢复上下文，
    3 秒恢复失败明确报错；打断后不恢复旧句子。
  - 自动回归与原生重测结果见 `docs/VOICE-OPTIMIZATION-VALIDATION.md`；
    原生真人听音待确认，未提交。

本轮覆盖此前固定回应与助手文字展示的设计，不重写阶段 3 历史记录。
与现有 4A 改动一起保留供 review；以下 commit 点均未实际提交。
证据及人工验收清单见 `docs/VOICE-OPTIMIZATION-VALIDATION.md`。

- [x] **PV.1 透明悬浮与精简反馈**
  - Tauri 无阴影、不主动聚焦、鼠标穿透；移除助手背景/文字/按钮及残留状态样式。
  - 删除固定回应事件和 TTS，保留阶段提示与客户端真实风险确认。
  - 验证：720×520 / 390×844 画布非空、动画变化、周边 alpha=0；
    页面无可见文字，VoiceLoop 无统一回应测试通过。原生体验见 PV.6。
  - Commit 点：`feat(assistant): render transparent voice halo`
- [x] **PV.2 播放协议、摘要与报告分离**
  - 句子、时间戳、实际播放位置、缓冲/失败事件；过滤旧轮次输出。
  - 单一控制器、真实音量驱动光环；Host 广播快照并保存最终文字/失败状态。
  - 验证：时间戳退化、队列/取消/失败、模型标记跨分片及缺失、
    SQLite 恢复测试通过；缺标记时保留最终文字，不朗读工具前过程。
  - Commit 点：`feat(voice): synchronize speech and persist conversations`
- [x] **PV.3 客户端 Markdown 与同步展示**
  - 转写、播放同步摘要、独立展开报告；禁用原始 HTML，保留来源链接。
  - 验证：浏览器表格/代码正常，危险链接与脚本未执行，
    旧快照不能覆盖失败提示，390×844 无横向溢出。
  - Commit 点：`feat(client): display synchronized Markdown answers`
- [x] **PV.4 连续采集与实时 STT**
  - Mono Worklet、连续重采样、停止握手/尾部 flush、数值诊断；
    录音期间送入 STT，partial 不进入 Pi。
  - 验证：44.1 kHz 分块与整块重采样一致、尾部保留、输入未结束可收到 partial；
    生产 Worklet 独立输出，同源 CSP 下可加载并实例化。
  - Commit 点：`feat(stt): stream continuous microphone input`
- [x] **PV.5 两种 ASR 同录音比较**
  - Qwen 近场/语言/热词设置，Fun-ASR 独立参数入口；可复现比较脚本。
  - 验证：当前云端三条同 PCM 合成录音均完成；准确度及延迟见验收文档。
    当时保留 Qwen 默认，后续切换见 PV.9；合成结果不代表真人准确率。
  - Commit 点：`test(voice): compare cloud ASR adapters`
- [ ] **PV.6 原生真人体验验收**
  - 桌面透出、鼠标穿透、不抢焦点、快捷键/托盘唤起。
  - 权限拒绝、快速按键、尾音、中英混合/长指令、真实音量波动、
    缓冲/失败、跨窗口同步、插话取消与真实风险确认。
  - 用真人同录音比较 CER / 延迟后，再决定是否更换默认模型。
  - 原生客户端已启动，上述人工体验尚未标记完成。
  - Commit 点：`test(desktop): validate native voice interaction`
- [x] **PV.7 首句延迟观测与 PCM 播放优化**
  - 复用单一 `AudioContext`，PCM 分片到达即排程，连续样本不使用压缩音频
    cross-fade；补齐模型首 delta、首句准备、TTS 首音频、真实播放和客户端
    首次文字准备的阶段计时。
  - 参考 Lumi 的分阶段 latency milestones、音频上下文复用和连续排程；
    不把单次 Provider 首音频数据宣称为端到端提速。
  - 验证：`voice-loop`、`PcmStream`、`VoicePlayer` 回归测试覆盖首片播放、
    欠载/暂停、队列、插话清理、奇数字节和重复 Provider 事件；`pnpm check`
    与 `git diff --check` 通过后保留未提交改动供 review。
  - 真实真人麦克风、原生透明窗口和扬声器延迟仍属于 PV.6，未在此处代替
    人工验收。
  - Commit 点：`perf(voice): reduce first-answer latency`
- [x] **PV.8 修复页面重载后的语音会话不同步**
  - 复现：同一 Worker 已创建 Pi 会话，页面重载新建 session ID，
    STT 成功后 `ensureSession` 拒绝切换，错误被误报为通用语音处理失败。
  - 实现：Host 的 `Conversation::start_turn` 保持会话身份，前端先采用
    `start_voice_conversation` 返回值；Worker 为异常会话冲突提供独立分类。
  - 验证：Host 与 Worker 定向回归通过；真实云端 STT → Pi → TTS 连续两轮
    均完成，沿用同一会话；`pnpm check`（78 个 JS、27 个 Rust 测试）、
    `cargo fmt --all -- --check` 与 `git diff --check` 通过。
  - 原生客户端与 Worker 已重新启动；真人快捷键、页面重载及扬声器体验
    仍由 PV.6 人工验收，不以合成录音或分层回归代替。
  - Commit：未提交，等待 review。
  - Commit 点：`fix(voice): retain session identity across page reloads`

- [x] **PV.9 切换默认识别模型为 Fun-ASR**
  - 按用户反馈，Worker 未配置供应商时默认 Fun-ASR；本机 `.env` 及示例配置
    显式设置 `fun-asr-realtime`，保留 `qwen` 回退，凭证与 TTS 未改动。
  - 验证：Worker 类型检查及 13 项适配器/Worker 测试通过；真实网关三条
    同 PCM 合成录音均完成，结果详见语音验收文档。真人准确率待体验。
  - 本轮不处理偶发卡住，不宣称此次模型切换修复该问题。
  - Commit：未提交，等待 review。

- [-] **PV.10 首字采集、空转写反馈与缺标记播报回退**
  - 按键即启动麦克风，不串行等待播放器、旧轮次暂停或 Host 握手；Worklet
    预加载并复用 AudioContext，握手期间按序缓冲 PCM，松键后保留尾音。
  - 空转写不再静默回 idle；缺 speech 标记时只从最终 post-tool 回答取一句，
    清除内部分析、代码与引用标识，不重试 Pi、不改当前 Fun-ASR 模型。
  - Mock WebAudio/IPC 验证慢握手不延迟采集、松键尾部保留、连续两轮复用、
    权限拒绝不提交；详细边界与结果记录于语音验收文档。
  - `pnpm check`（81 JS / 27 Rust）、Rust 格式检查与 `git diff --check`
    通过；原生客户端与 Worker 已重启，保留当前模型。
  - 原生真人首字、短句及偶发空输入仍待体验，不能以 Mock 代替。
  - Commit：未提交，等待 review。

- [x] **PV.12 修复连续录音的轮次竞争与迟到 Worklet 消息**
  - 历史方案：等待网络收尾才开始新录音、排队期间松键即取消的行为，
    已由 PV.16 的独立本地门控和逐轮缓冲替代；旧消息隔离约束继续保留。
  - 收尾完成前不替换轮次身份；重复松键共用停止操作；排队时已松键则
    取消新录音并提示重试；分片发送捕获 request ID。
  - Worklet 停止后解绑端口并隔离旧节点回调，旧 samples / flush 不进入新轮次。
  - 修复前确定性测试复现新麦克风被旧收尾关闭、旧音频进入新重采样器；
    新增 7 条回归，`pnpm check`（90 JS / 27 Rust）、Rust 格式检查、
    `git diff --check` 通过；详见语音验收文档。
  - STT 模型不变。真人空转写的全部成因及原生连续按键体验仍由 PV.6 验收。
  - Commit：未提交，等待 review。
  - Commit 点：`fix(voice): isolate recording turn lifecycles`

### 2026-10-08：常驻采集、通用助手与声音动效

以下四块均保留未提交改动，等待 review。自动验证已通过，不代表真人
识别准确率、原生透明窗口或扬声器效果已验收。

- [x] **PV.16 常驻麦克风、逐轮门控与设备设置**
  - 启用预热后复用轨道、独立 AudioContext 和 Worklet；闲置采样在
    Worklet 内丢弃，不保存、不缓冲、不上传。按键立即开门，松键冲刷尾音。
  - 本地采集与 Host/云端提交分离；旧轮次提交期间的新按键可以采集，
    每轮身份、序号与缓冲独立，设备关闭和迟到消息不能污染下一轮。
  - Host 保存语音/预热开关，客户端可修改；关闭、退出、设备断开释放资源，
    闲置设备切换和上下文恢复重建就绪状态。区分无采样、静音和服务错误。
  - 验证：真实 Worklet 源码门控、慢握手、三轮连续采集、尾音、权限拒绝、
    设备切换、挂起恢复、关闭设置和退出后旧请求隔离回归通过。
  - 首次授权、真人立即说话、实际休眠恢复及设备切换仍待 PV.6 人工验收。
  - Commit 点：`fix(voice): prewarm microphone and isolate capture gates`
- [x] **PV.17 Fun-ASR 独立词表入口与真人评测工具**
  - 增加 `SEMI_OS_FUN_STT_VOCABULARY_ID`，校验并通过 Fun Adapter 发送；
    参数拒绝明确反馈，不混用 Qwen 参数、不删除词表静默重试。
  - 基准脚本读取同一批真人 WAV；至少 30 条、六个分类，统计加权 CER、
    关键实体准确率、失败数和最终转写延迟 P50/P95，默认不输出文字。
  - 验证：词表参数/错误分支、WAV 结构、编辑距离和分位数回归通过，
    两个脚本独立严格类型检查通过。当前默认模型和现有凭证不变。
  - 词表网关兼容性、30 条真人双模型比较未完成；准备说明见
    `docs/VOICE-HUMAN-CORPUS.md`，本复选框仅表示入口与工具实现完成。
  - Commit 点：`feat(stt): add Fun vocabulary and human corpus evaluation`
- [x] **PV.18 通用身份、隔离工作目录与可选详情**
  - 使用 Pi 官方 ResourceLoader 的系统提示替换编码助手定位；创建前
    reload，取消每轮用户指令后缀，保留模型认证、原生工具与 Host 扩展。
  - 默认使用应用数据目录的中立工作目录，不发现开发/个人 AGENTS、
    SYSTEM/APPEND、第三方扩展、Skill 或提示模板，只显式加载内置资源。
  - 简单回答仅口头摘要；报告可选，不复制摘要冒充详情，客户端隐藏空报告。
    调研继续保留证据与详情；用户明确项目任务时仍可使用文件工具。
  - 验证：真实 Pi ResourceLoader 的受污染目录隔离、内置 Skill/Host
    扩展保留，以及摘要归一化回归通过。旧记录不删除，新提示在新会话生效。
  - 干净原生会话的闲聊、网络调研和明确项目任务仍需真人验证。
  - Commit 点：`fix(agent): isolate general assistant identity and optional reports`
- [x] **PV.19 播放包络、光环声振与延迟记录**
  - PCM 预计算 20 ms RMS 包络，按 HTMLAudioElement 的实际播放位置
    读取；保留有声 WAV 出口，不增加 WebAudio 输出节点。
  - 本地 ref 驱动内层细颤、外层小幅脉动和重音粒子传播，不逐帧更新
    React/IPC/数据库；暂停、缓冲和取消回落，减少动态效果时禁用声振。
  - Host 仅保存数值延迟；脚本按轮次/阶段首次记录计算 P50/P95，不把
    Provider 首包当作实际出声，不从 Mock 数据宣称真人端到端提速。
  - 验证：静音/重音 PCM、奇数字节分片、媒体时钟、暂停/恢复/取消回归
    通过；720×520 / 390×844 非空且周边透明，合成振幅改变形变，
    减少动态效果两次截图逐像素一致。原生录屏和真人听音仍待 PV.6。
  - 最终 `pnpm check`：117 个 JS、29 个 Rust 测试通过，类型检查、
    仓库 lint、Clippy 与构建通过；保留既有大 chunk 警告。
  - Commit 点：`feat(assistant): animate halo from actual speech playback`

### 2026-10-10：文字测试入口

- [x] **PV.20 客户端文字对话，共用语音后的处理链路**
  - `TextComposer.tsx`：多行草稿、Enter 发送、Shift+Enter 换行、输入法保护、
    防重复发送、失败保留草稿；等待回执期间编辑不会被旧请求清空。
  - Rust `text_input.rs` / `main.rs`：校验客户端提交、助手就绪和关联回执，
    定向转发给唯一语音控制器；超时接收结果未知，不自动重试。
  - `VoiceClient.submitText` / Worker `voice.text.submit`：只跳过采集和 STT，
    共用 Pi Session、工具/确认、TTS、同步 Markdown、光环及 Host 保存。
    新文字立即中断旧播报，关闭录音且不额外提交；无麦克风也可发送。
  - 中文/Emoji 长度跨协议和 Host 保存统一按 UTF-16；迟到麦克风预热失败
    不覆盖文字轮次。历史正序、底部跟随，向上阅读时保留滚动位置。
  - `pnpm check`：125 项 JS（Desktop 42、Worker 70、Protocol 8、
    Tool SDK 3、Shared 2）及 32 项 Rust 通过；类型检查、lint/Clippy、
    JS/Rust 构建通过，保留既有大 chunk 警告。
  - 浏览器验证输入框及失败草稿，390×844 无水平溢出；原生云端文字
    回复、声音、跨窗口确认与语音交替仍需人工验收，见语音验收文档。
  - Commit：未提交，等待 review。
  - Commit 点：`feat(chat): add text input to shared voice-agent pipeline`

### 2026-10-10：Codex 风格对话工作台

- [x] **PV.21 客户端对话主界面重构**
  - `ResearchWorkbench.tsx`：改为可收起、可拖拽的左侧会话栏、中间对话区和右侧上下文栏；
    中间区继续消费 Host 快照，未伪造会话、任务或来源内容。
  - `ConversationPanel.tsx`：用户消息右对齐，Agent 回复左对齐；移除头像和大卡片，
    使用 `react-markdown + remark-gfm` 渲染 Markdown，并在真实快照更新期间显示流式光标。
  - `styles.css`：采用连续的黑白灰工作区，移除明显竖向分割线、玻璃卡片和背景图；
    分隔条只在交互时显示，输入区与选中态使用柔和圆角。窄屏自动切换为单栏。
  - `icons.ts`：通过语义图标适配层提供侧栏折叠和恢复图标，业务组件不直接绑定图标库。
  - 验证：`pnpm --filter @semi-os/desktop typecheck`、`git diff --check`、
    Oil UI 截图检查（`1440×900`、`390×844`）通过；无控制台错误、水平溢出或图片加载失败。
  - Commit：未提交，等待用户 review。
  - Commit 点：`feat(client): refine codex-style conversation workbench`

### 2026-10-11：精简工作台入口

- [x] **PV.22 输入区层级与设置入口**
  - 去掉输入区上方横线，以浅灰输入框和留白划分层级；删除输入框下方工具栏。
  - 左上角固定显示 `SemiOS`，右上角提供助手显隐按钮，不受侧栏折叠影响。
  - 左下角新增设置入口，现有语音开关、麦克风预热与浏览器登录收进原生对话框；
    窄屏保留独立设置入口。设置内容暂不扩展。
  - 验证：桌面 TypeScript 检查、`git diff --check` 通过；浏览器验证设置打开、
    Escape 关闭、输入区上边框为零，当前视口无横向溢出。
  - 限制：浏览器截图调用超时；本轮未完成视觉截图及原生 Host 设置操作验收。
  - Commit 点：`feat(client): simplify workspace controls`；未提交，等待 review。

- [x] **PV.23 右侧上下文浮层卡片**
  - 右侧改为固定 320px 宽的白色卡片，高度为工作区约三分之一，
    使用轻阴影提升层级，长内容在卡片内部滚动。
  - 移除右侧拖拽分隔条、折叠按钮和对应状态；左侧会话栏行为保留。
  - 卡片仅显示当前进度且无滚动条；“更多”展开全高资料抽屉，从右向左推开工作台，
    全部进度、引用和来源正文移至抽屉，支持关闭按钮与 Escape。
  - 验证：TypeScript、`git diff --check` 通过；浏览器验证固定 320px 宽、
    无右侧拖拽/折叠入口、抽屉全高及 Escape 关闭。真实资料长列表尚待体验。
  - 未提交，等待 review。

- [x] **PV.24 对话刻度导航与问答预览**
  - `ConversationNavigator.tsx`：对话区左缘显示细刻度，随阅读位置高亮；
    鼠标悬停或键盘聚焦显示当前及下一轮的真实问答摘要，点击平滑跳转。
  - `ConversationPanel.tsx`：按 requestId 定位当前展示轮次；主动跳转后停止
    自动追随新内容，减少动态效果设置下使用即时跳转，不新增会话或收藏行为。
  - 验证：桌面类型检查、`git diff --check`；独立测试页三次跳转/流式追加
    保持阅读位置通过。测试页已删除，未写入 Host。
  - 已查看桌面/窄屏截图：`/tmp/semios-navigation-preview/` 和
    `/tmp/semios-navigation-shots/`；无横向溢出，测试页 favicon 404。
  - 未做独立视觉评审，原生长期使用体验仍待用户 review；未提交。

- [x] **PV.25 单 Session 历史展示与隐藏主区滚动条**
  - 左侧固定一个“默认会话”，普通消息和 TaskRun 不再生成 Session 条目；
    移除按 taskId 筛选对话，已有历史统一连续展示，右侧任务进度独立保留。
  - 主对话区隐藏标准与 WebKit 滚动条，保留滚轮、键盘和刻度跳转。
  - 验证：桌面类型检查、`git diff --check` 通过；临时测试页模拟
    16 轮不同任务/历史会话 ID，全部显示在一个 Session 中；跳转第 4 轮成功，
    追加第 17 轮后侧栏仍只有一项且阅读位置不变。测试页已删除。
  - 边界：本轮仅统一展示，不改写 SQLite 历史身份、不重建 Pi 上下文；
    手动新建/切换独立 Session 的 Host 与 Worker 生命周期尚未实现。
  - 未提交，等待 review。

- [x] **PV.26 手动新建与切换真实 Session**
  - 左侧顶部新增图标式“新建会话”；普通消息仅追加到当前会话，
    支持切回旧会话，空会话也保留；最初的首条消息自动命名已由 PV.27
    的用户弹窗命名取代。
  - Rust Host/SQLite：`0004_client_sessions.sql` 迁移及会话仓库维护唯一
    active 选择；已有归档统一映射默认会话，原始 JSON 的旧运行身份保留。
    切换经过助手回执，过期请求不得改变选择，失败不自动重试。
  - 助手控制器立即停止旧录音/播报并排队暂停；Worker 按 Session 懒加载、
    复用独立 VoiceLoop/Pi Adapter，过滤非 active 会话的迟到事件。
    切换期间禁用输入；切回恢复归档文字，保留隐藏滚动条与刻度导航。
  - 验证：桌面 46 项、Worker 72 项、Storage 8 项及 Tauri 5 项测试通过；
    类型检查、桌面生产构建、Rust Clippy/格式检查和 `git diff --check` 通过。
  - 浏览器 IPC Fixture 验证：16 轮默认历史；手动新增后连发两条消息，
    会话条目仍为两项；来回切换、Markdown、隐藏滚动条、折叠栏图标不重叠
    均通过。临时测试页已删除；截图调用超时，未完成视觉截图与原生云端验收。
  - 边界：独立 Pi 上下文只在同一 Worker 生命周期内保留；跨重启恢复会话列表
    和文字归档，不恢复 Pi 上下文。归档目前最多读取所有会话最近 200 轮。
  - Commit 点：`feat(session): add manual creation and switching`；未提交，等待 review。

- [x] **PV.27 Session 命名、重命名与删除**
  - 新建按钮先弹窗输入名称，取消不创建；已有条目右键提供重命名/删除，
    支持 Shift+F10、菜单方向键与 Escape。删除需二次确认。
  - `SessionControls.tsx` 独立管理原生模态层、焦点与失败输入保留；
    Host/SQLite 校验并持久化名称（最多 80 UTF-16 单元），新消息不再覆盖名称。
  - 删除当前会话经助手停止录音/播报后，原子切换并删除聊天归档；
    删除最后一个保留空白“新会话”。Host 绑定原始删除意图，迟到或错目标
    回执不能更改选择。非当前会话删除不打断活跃对话。
  - Worker 通过 `voice.session.dispose` 释放指定 Pi 上下文，重复请求幂等，
    清理时及清理后的事件不再发往客户端；独立任务证据和浏览器 Profile 保留。
  - 验证：desktop 47、Worker 73、protocol 9 个 JS 测试；Rust storage 10、
    desktop 6 个测试覆盖名称持久化、无效输入、归档删除/事务回滚和回执绑定。
    相关 typecheck/lint、桌面 build、Rust clippy/fmt、diff-check 通过。
  - Ego 浏览器 IPC Fixture 验证取消创建、命名创建、预填重命名、取消删除、
    非活跃/活跃/最后会话删除、输入恢复及键盘菜单。弹窗布局位于视口内；
    截图接口超时，未获得截图。原生完整链路仍需重启客户端手工验收。
  - Commit 点：`feat(session): add naming and context actions`；未提交，等待 review。

## 阶段 4B：用户主导的多 Agent 协作工作流

依赖：P2.4 至 P2.12、P3.7 至 P3.10。

- [x] **P4B.1 协作契约、任务 DAG 与计划批准**
  - [x] 定义 WorkflowPlan、WorkItem、AgentRun、ReviewFinding、IntegrationResult，角色与 Provider 分离。
  - [x] 跨进程运行时校验；拒绝环、重复身份、未知依赖及越界工作区。
  - [x] Host 保存不可变计划版本、批准记录、快照和追加事件。
  - [x] 批准绑定当前版本、内容摘要、意图代际；批准前实施禁止、Worker 无批准入口。
  - [x] 真实用户批准/拒绝/要求修改入口；过期批准与重复请求测试。
  - 证据：TS/Rust `workflow` 契约、storage `0005–0007` 迁移与批准测试；
    `WorkflowPanel` 经 Tauri IPC 发出精确版本请求。`pnpm check` 通过。
  - Commit 点：`feat(workflow): add versioned plans and approval gate`
- [x] **P4B.2 公共进程层、并发与 worktree**
  - [x] 管道与 PTY 生命周期、LF 分帧、有界输出、进程树取消。
  - [x] 最多两个子 Agent，依赖就绪才运行，同仓库写入工作区独占。
  - [x] 仓库身份/基线/codex 分支/归属；脏仓库 needs_user 与显式基线。
  - [x] 依赖成果版本、只读隔离、非 Git 并行写拒绝及安全清理测试。
  - 证据：`collaboration/process.ts`、`service.ts`、`workspaces.ts` 与对应测试。
    合成 Git 仓库验证源分支不变、冲突保留、重启归属及历史改写拒绝；`pnpm check` 通过。
  - Commit 点：`feat(coding): add process scheduler and isolated workspaces`
- [x] **P4B.3 独立 Provider 接入**
  - [x] Pi CLI RPC：启动、观察、steer、清队列取消、恢复及权限拦截。
  - [x] Claude 结构化流：本地认证、增量输出、控制与权限请求。
  - [x] Codex app-server：线程/轮次、批准、追加指令、取消与恢复。
  - [x] 统一实际能力；不支持的暂停/恢复/权限拦截明确拒绝，不用跳过权限选项。
  - [x] 确定性异常流及已认证 CLI 冒烟，单独记录认证缺口。
  - 证据：三个 `*-provider.ts`、`providers.test.ts`；Pi/Claude/Codex 合成文件
    只读及写入冒烟通过，写入均观察到权限请求。Claude 不提供轮中 steer；
    所有 Provider 不声称原地暂停。恢复为显式新尝试，未完成的实测边界见验收文档。
  - Commit 点：三个 Provider 各自 `feat(coding): add <provider> adapter`
- [x] **P4B.4 结构化进度、监督队列与持久化**
  - [x] 阶段、工具活动、阻塞、权限、完成及异常标准事件。
  - [x] Host SQLite 持久化队列/执行回执；先保存再发布 UI。
  - [x] 主 Pi 边界消费、用户指令优先、不轮询模型、不自动重启子任务。
  - [x] 对话结束不强制研究报告，不取消后台协作。
  - 证据：storage 监督游标、Worker 串行消费与用户抢占测试。
    无活动健康检查产生持久化事件，并在主 Pi 可处理边界通知一次，不自动重启；
    只读成果要求干净且基线不变。Claude 失败仅显示脱敏类别，不泄露原始错误。
    `pnpm check` 覆盖语音/文字、研究与 Session 回归。
  - Commit 点：`feat(workflow): persist execution and supervision events`
- [x] **P4B.5 协作工具、Skill 与可视化**
  - [x] 官方 Tool Registry 注册提案/调整图/派单/观察/控制；内置协作 Skill。
  - [x] 卡片摘要/活跃工位，全高抽屉任务依赖/时间线/成果详情。
  - [x] 批准、修改、拒绝、暂停、恢复、取消及阻塞回答真实入口。
  - [x] UI 不解析推理、不造百分比；简单任务不强制流水线。
  - 证据：`workflow-tools.ts`、内置 collaboration Skill、`WorkflowPanel.tsx`；
    快照合并测试拒绝迟到版本。浏览器 IPC Fixture 的按钮和布局记录见验收文档，
    不等同于原生完整链路验收。`pnpm check` 通过。
  - Commit 点：`feat(workflow): add orchestration tools and workstations`
- [x] **P4B.6 交付、整合与版本绑定验证**
  - [x] 已批准授权才保存本地交付提交；收集 diff/文件/测试/诊断。
  - [x] 独立整合 worktree 按依赖串行 cherry-pick；冲突/失败保留。
  - [x] 整合测试及独立审查绑定版本，后续修改使证据失效。
  - [x] 三轮返工问题转 needs_user；禁止自动修改用户当前分支。
  - [x] 客户端“应用到当前分支”独立确认入口及干净/基线检查。
  - 证据：真实 Git/测试运行器闭环及 Rust 证据校验通过；缺 Artifact、自审、
    过期版本不能设为 verified。客户端预览源仓库/ref/HEAD 和整合版本后独立确认；
    Host 单次令牌绑定全部身份，仅允许干净源分支 fast-forward，不 push。
    执行失败或重启中断标为 unknown，用户核对后废止旧令牌，禁止盲目重试。
    Git 测试覆盖脏目录、变化基线、分支切换、分叉拒绝与成功应用；
    浏览器 IPC Fixture 验证确认载荷，原生实测仍归 P4B.8。`pnpm check` 通过。
  - Commit 点：`feat(workflow): integrate deliverables with revision evidence`
- [x] **P4B.7 用户改意图、中断与重启恢复**
  - [x] 停止受影响新操作、协调在途操作、保留旧成果及历史尝试。
  - [x] 实质变化重新批准，旧事件不污染新代际；范围内重分工留痕。
  - [x] Session 切换/停止播报不取消协作；Provider 会话恢复及 unknown 对账。
  - [x] 重启不盲重复、脏/未整合/状态不明 worktree 保留。
  - 证据：Worker 抢占/监督失败游标、storage 恢复/新意图证据历史、
    worktree 归属及续接基线检查通过。后台优化后，重启只续排 Host 证明未启动、
    无工作区的任务；已发送启动请求及 unknown 由用户核对，保留现场再显式续接。
    暂停/取消/待重批不得自动恢复。活跃工作流阻止删除 Session，避免失去控制入口。
  - Commit 点：`feat(workflow): reconcile interruptions and intent changes`
- [-] **P4B.8 多 Agent 闭环验收**
  - [x] Fixture 覆盖批准前只读、过期/拒绝、循环依赖、并发和异常进程。
  - [x] 合成 Git 仓库验证规划、并行实施、整合、测试和独立审查；
        Rust 测试补充计划修订、返工上限及版本证据。
  - [-] 真 CLI 认证/读取/写入权限冒烟通过；完整主 Pi + Rust Host +
    两种真实子 Provider、轮中追加指令与后台对话原生联调尚待验收。
    真实 Rust Host/SQLite + Pi/Claude 合成协作本次完整通过：
    5 次尝试、18 次权限请求，独立 worktree 并行、串行整合、
    `node check.mjs` 退出 0、独立审查与版本证据持久化成功，源仓库不变。
    Claude 恢复为 `2.1.261` 后临时关闭进程自动更新，认证未变。
    测试桥驱动批准及流程，不声称主 Pi 自主编排与原生客户端验收通过。
    Codex 写入复测通过；后续后台优化已补 Host 只读命令/真实路径分类及回归，
    未知 shell 仍须用户。真实 Codex 产品层原生规划/审查仍待验收，
    独立 Provider 冒烟不能代替产品层验证。
  - [x] 回归资料调研、语音、文字对话、Session；`pnpm check`、Rust fmt 通过。
        本次全套 215 个测试通过；真实云端合成语音调研采集 2 个网站、
        保存 2 份正文 Artifact，保留 3 条失败来源，生成 9 句 PCM 且无语音错误。
        后端单次耗时 59.358 秒，不代表真人录音及实际扬声器出声验收。
  - [x] 更新 `docs/4B-VALIDATION.md`，区分自动测试/真实 CLI/原生手测。
  - 所有 4B 改动未提交，等待 review。4A 已提交并 push：`b2ab28e`，
    任务交付记录 `923af22`。本次不再提交或 push。
  - Commit 点：`test(workflow): verify user-led multi-agent collaboration`

### 2026-10-11：4B 后台托管优化

以下五块可独立 review；实现和确定性验证与原生验收分别标记，不将所有场景合并为“通过”。

- [x] **P4B.O1 权限分类、监督唤醒与执行阶段**
  - Host 解析受控只读 shell 与真实路径；拒绝越界、未知命令和危险 Git 选项。
  - macOS 受限测试运行器禁网、去除密钥、限制工作区/临时目录写入；不宣称 Provider 全局沙箱。
  - 保存 `not_started/start_requested/executing/saved`；安全通信按 2/10/30 秒重试，模型/工具不重放。
  - 精确工作流通知直接进入持久领取，不让 Session 查询失败吞掉终态唤醒。
  - 证据：`workflow_policy.rs`、`test-runner.test.ts`、`coordinator.test.ts`、
    `worker-service.test.ts`、storage 恢复测试；真实 macOS 越界读写/网络拒绝测试通过。
  - Commit 点：`fix(workflow): classify permissions and retain background wakeups`
- [x] **P4B.O2 托管授权与结构化子 Agent 决策**
  - 真人批准保存 grant，绑定计划/意图/仓库/动作；实际操作复核工作项及工作区。
  - 子计划/澄清请求持久化，代理和真人答案分别记录；新目标/偏好/权限转用户。
  - Claude `AskUserQuestion` 真实 CLI 回调通过；不模拟键盘、不使用跳过权限模式。
  - `ExitPlanMode` 未验证，保留“计划产出 → 主 Pi 审查 → 明确实施工作项”兼容流程。
  - 证据：`0008/0009` 迁移、Host/storage 决策测试、`smoke-claude-decision.ts`；
    实测 1 次结构化问答，无键盘批准。Claude 子进程保持关闭自动更新，不改 CLI 安装。
  - Commit 点：`feat(workflow): add delegated grants and provider decisions`
- [x] **P4B.O3 独立后台 Pi、持久事件及启动对账**
  - 每工作流独立 Pi 会话/应用数据 cwd，仅所属协作工具；无事件不调用模型、不接语音。
  - Host 独占领取者、90 秒租约、25 秒续租、检查点与事件回执；重复通知不重复派单。
  - 三轮无实质进展由持久事件校验，不能用 Worker 声称进展绕过；未知结果等待核对。
  - 重启只恢复可证明未启动队列；在途及脏现场保留，暂停/取消/待重批不自启。
  - 证据：`coordinator.ts`、`workflow_background.rs`、storage 无进展/互斥/恢复测试；
    `smoke-background.ts` 通过真实 Pi SDK、Rust Host/SQLite、Pi/Claude CLI。
  - Commit 点：`feat(workflow): persist independent Pi coordinators`
- [x] **P4B.O4 查询、用户优先入口、进度与托盘提示**
  - 跨 Session 按名称/仓库/批准或执行状态找任务；通知以精确 ID 打开任务。
  - UI 修改要求先经 Host 撤销旧授权再停止执行；普通聊天不抢占后台。
  - 卡片/抽屉增加最后活动、阻塞原因、真实问答及核对后继续入口。
  - 完成/待用户处理发布去重客户端通知与托盘提示；后台不播报，尚未接系统通知中心。
  - 证据：`WorkflowPanel.tsx`、`workflow-model.test.ts`、Tauri 通知和用户命令；
    跨批准/执行状态查询、前台不打断后台自动测试通过。原生窗口生命周期见 O5。
  - Commit 点：`feat(workflow): expose background progress and priority controls`
- [-] **P4B.O5 自主闭环与故障验收**
  - [x] 真实后台 Pi 自主闭环：总计划预先定义、真人批准一次；11 个事件轮次、
        4 次执行尝试、并行独立 worktree、整合、真实测试、独立审查及 verified 持久化。
        测试脚本不代替 Pi 选择推进步骤，源仓库未变。
  - [x] 确定性回归覆盖通信重试/无进展、重复领取/回执、未知执行、暂停/取消、
        越界权限、过期授权、版本失效与既有语音/调研/文字/Session。
  - [x] 同步 `AGENTS.md`、架构/决策和 `docs/4B-VALIDATION.md`；
        最终检查命令及数量以验收文档为准。
  - [-] 原生关闭窗口/显式退出、真实聊天并行/跨 Session、Worker 崩溃与断网、
    权限等待中恢复及真正自主返工仍待专项体验验收。
    当前真实冒烟不证明 Pi 动态创建初始任务图或真实子计划审批。
  - Commit 点：`test(workflow): validate autonomous background collaboration`

本轮不 commit、不 push。自动通过不能代替上面明确保留的原生/故障验收。

## 阶段 4C：原生桌面与 Lark 工作流

依赖：P2.4 至 P2.12、P3.7 至 P3.10。

- [-] **P4C.1 添加 macOS 权限能力检查**
  - 已实现 `crates/desktop-macos/src/native.rs`、Tauri 权限状态/系统设置入口和
    `DesktopPermissions.tsx`。
  - 新增程序化授权入口：`PermissionKind` 闭集（accessibility / inputMonitoring /
    screenRecording / microphone）与 `request_permission`，仅由客户端「请求授权」
    按钮触发；`MacDesktop::permissions` 不请求授权，启动与轮询路径不会弹窗。
  - 授权成功会作废当前桌面租约（`DesktopService::apply_permission_change`），
    避免授权前的观察和批准被带进新权限继续派发；`crates/host/src/desktop_tests.rs`
    新增 4 项覆盖（首次读取不误废租约、权限变化作废旧批准、授权成功释放租约、
    未决请求不影响现有任务）。
  - 验收通道：`tauri.conf.json` 启用 bundle，当前使用
    `signingIdentity: "Semi-OS Local Signing"` 固定证书，指定要求包含
    `Identifier=dev.semios.desktop` 与稳定 certificate root，Info.plist 已密封。
    不再使用历史 ad-hoc 配置作为当前验收依据。验收产物为工作区共享
    `target` 下的 `target/debug/bundle/macos/Semi-OS.app`。
  - 验证：`cargo test -p semi-os-desktop-macos`（4 passed，含一个只读回选项字典、
    不调用授权 API 的 FFI 测试）、
    `cargo test -p semi-os-host`（65 passed）、
    `node --experimental-strip-types --test src/ui/desktop-permission-request.test.ts`
    （2 passed）、`pnpm check`（exit 0）。已实际执行
    `pnpm --filter @semi-os/desktop exec tauri build --debug` 并在 `open` 后确认
    应用从 bundle 启动、退出正常。真实 macOS 权限状态、系统弹窗和重启后权限
    保持仍需按 `docs/4C-VALIDATION.md` 的 Native Acceptance Procedure 人工验收，
    暂不标记完成。
  - Commit 点：`feat(macos): add permission capability checks`
- [-] **P4C.2 添加 Accessibility 观察**
  - 已实现版本化窗口/元素引用、敏感字段脱敏、截断标记和过期/歧义校验；
    `crates/host/src/desktop_tests.rs` 覆盖合成 Accessibility Fixture。真实
    TextEdit 语义树读取仍需人工验收，暂不标记完成。
  - Commit 点：`feat(desktop): add accessibility observation`
- [-] **P4C.3 添加原子桌面动作**
  - 已注册七个工具并接入 Rust Host 租约、真人接管、单动作执行、读回验证和
    `unknown` 保护；Host Fixture 测试通过。真实 TextEdit 中英文输入、窗口聚焦
    和用户接管仍需人工验收，暂不标记完成。
  - Commit 点：`feat(desktop): add atomic desktop actions`
- [-] **P4C.4 添加受约束的视觉回退**
  - 协议、能力状态和工具边界已接入；当前实现明确返回 `unavailable`，没有
    虚假宣称视觉模型可用。需要真实图片调用、目标绑定和敏感界面拒绝证据后
    才能标记完成。
  - Commit 点：`feat(desktop): add visual fallback`
- [-] **P4C.5 添加 Lark CLI 能力适配器**
  - 已实现 CLI 能力检测、文档搜索/读取、会话查询、结构化消息发送、幂等键
    和超时对账；`lark-service.test.ts` 9 项通过。真实 CLI 认证、测试文档和
    测试会话仍需人工验收。
  - Commit 点：`feat(lark): add cli capability adapter`
- [-] **P4C.6 添加通用应用工作流**
  - 已接入 `desktop.request/result`、客户端权限/桌面状态展示以及观察→单动作→
    读回验证链路。需要真实 Tauri + TextEdit 闭环后才能标记完成。
  - Commit 点：`feat(desktop): add generic application workflow`
- [-] **P4C.7 添加桌面恢复用例**
  - 已覆盖权限拒绝、人工接管、过期/重复目标、租约代次变化、动作后断连、
    重启转 `unknown`、重复 request/attempt ID、Worker/Lark 发送未知结果及
    `userId` 超时不得使用空 chat ID 对账。`cargo test -p semi-os-storage
--test recovery` 12 项、Agent Worker 124 项通过；真实应用关闭、断网和
    原生权限等待恢复仍需人工验收。
  - 全仓 `pnpm check` 已通过，覆盖协议生成校验、格式、类型、ESLint、
    Rust Clippy、全量 JS/Rust 测试、前端/Rust 构建及 `git diff --check`。
    自动门禁不替代 `docs/4C-VALIDATION.md` 列出的真人原生验收。
  - Commit 点：`test(desktop): verify native workflow recovery`

## 阶段 5：记忆、人格与用户偏好

依赖：P2.1 至 P2.7、P2.13 至 P2.15。可与阶段 4 并行。

- [x] **P5.1 添加六层记忆 Schema**
  - `memories`、`memory_sources`、`memory_links` 分开保存 L0–L5、来源和
    supersedes / contradicts / consolidates / associates。压缩摘要只能是 L0，
    L4 只存证据指针；作者与可变更性成对落库。未做检索、自动写入或提示词组装。
  - 证据：`crates/storage/migrations/0013_memory_layers.sql`、
    `crates/storage/src/memory.rs`；`cargo test --locked -p semi-os-storage` 通过。
  - Commit 点：`feat(memory): add six layer schema`（`f358e9c`）
- [x] **P5.2 添加作者与可变更权限**
  - 记录区分 user / agent / system。Agent 修改或删除用户人格、用户偏好会被拒绝，
    原文和旧版本保持不变；修正只能新增 Agent 记录并建立关系。系统不能改写用户记录。
  - 证据：`crates/storage/migrations/0014_personality_ownership.sql`、
    `memory.rs` 的所有权测试；`cargo test --locked -p semi-os-storage` 通过。
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
- [x] **P7.6 添加 CI**
  - 运行格式化、Lint、TypeScript 检查、Rust 检查、单元测试、契约测试和确定性集成 Fixture。
  - 已配置 macOS GitHub Actions 执行 `pnpm check`；本地门禁已验证。
    未 push，本轮不宣称托管 Actions 已运行成功。
  - Commit 点：`ci(repo): add continuous integration`
- [ ] **P7.7 添加发布打包配置**
  - 配置应用元数据、签名/更新器占位、权限说明、Provider 设置和首次启动能力检查。
  - Commit 点：`chore(release): prepare desktop packaging`
- [ ] **P7.8 MVP 发布门禁**
  - 端到端运行三类验收工作流，记录证据，并在本文件中更新发布 commit 和已知限制。
  - Commit 点：`chore(release): close MVP gate`

## 阶段 8：架构加固与质量基线

依赖：阶段 1 至阶段 4B；不提前实现 P4C、P5 或 MCP。

- [x] **P8.1 建立质量基线与 CI**
  - 已添加 ESLint Flat Config、Prettier 配置、独立质量命令和 GitHub
    Actions；历史文件通过 `.prettier-baseline` 保持最小 diff。
  - workspace 预检逐个验证必需脚本并提供明确诊断；精确内容 baseline
    仅豁免未修改历史文件。托管干净环境的 Actions 运行仍待 push 后验证。
  - 证据：`eslint.config.mjs`、`.prettierrc.json`、`scripts/check-format.mjs`、
    `.github/workflows/quality.yml`、`package.json`。
  - 当前验证：`pnpm run lint:js`、`pnpm run format:check`、
    `pnpm run typecheck`、`pnpm run test:js`、Rust 检查和
    `git diff --check`。
- [x] **P8.2 类型化现有协议 Payload**
  - [x] 建立 Host/Worker 外部消息注册表，覆盖 voice、research、workflow、
        browser、health、lifecycle 及跨运行时契约 Fixture；Pi Runtime 内部事件不
        进入外部注册表。
  - [x] `assertValidEnvelope` 和 Rust `validate_envelope` 按 direction/kind
        拒绝未知消息、错误 payload 形状和不支持协议版本；领域模块继续负责字段、
        长度、状态与 DAG 的深层校验。
  - [x] Schema 包含现有 kind 的字段级 payload；生成 TS 判别联合、
        Rust DTO 和校验 schema，生成一致性进入质量门禁。
  - [x] `worker-service.ts` 迁移为类型化 switch，默认分支进行穷尽检查；
        跨运行时共享 Fixture 验证未知 kind、畸形字段和未来版本拒绝。
  - 证据：`packages/protocol/src/message-registry.ts`、`envelope.ts`、
    `schemas/protocol.schema.json`、`crates/protocol/src/lib.rs`；
    `packages/protocol` 与 `semi-os-protocol` 的未知 kind/错误 payload 测试。
- [x] **P8.3 渐进拆分 Host 路由与统一错误边界**
  - [x] 新增 `HostError` 与稳定的 UI 安全错误映射，保留旧 Tauri/Worker 入口的
        `String` 兼容层。
  - [x] 抽取可脱离 WebView、Worker 和 SQLite 的生命周期路由命令与状态转换测试。
  - [x] 抽取 voice 事件核心路由：校验 `requestId`、`sessionId`、`taskId` 和
        payload 后再替换会话快照；旧事件、非 voice 事件和迟到 `idle` 不污染当前状态。
  - [x] 抽取 research 事件分类核心：Tauri 入口不再自行判断事件身份、策略确认、
        终态和持久化操作的类别。
  - [x] research/workflow 的 Storage 与 Worker 回执副作用移出入口；
        Host 核心脱离 WebView 测试，桌面 `router/` 处理 UI 投递与组装。
  - 当前证据：`crates/host/src/error.rs`、`crates/host/src/lifecycle.rs`、
    `crates/host/src/voice.rs`、`crates/host/src/research_router.rs`；
    `cargo test -p semi-os-host`、`cargo check -p semi-os-desktop`。
- [x] **P8.4 收敛 Storage/Policy DTO 边界**
  - 对外查询接口使用明确 DTO；数据库内部仍可使用 JSON 兼容历史字段，
    不修改已执行 migration。
  - [x] 工作流快照、后台协调、计划授权、决策输入、通知与查询结果已使用
        `WorkflowSnapshotDto` 等明确 DTO；原始 JSON 查询限制为 crate 内部。
  - [x] Tauri 查询、通知、Ready 恢复、运行核对与 Policy 授权均先解码 DTO，
        不再把任意快照 JSON 直接发送到 WebView 或索引为业务状态。
  - [x] 覆盖结构化问题输入、Claude `multiSelect`、脏事件、权限撤销和损坏
        快照测试；通过 `cargo test -p semi-os-storage`、`cargo test -p semi-os-host`
        与 `cargo check -p semi-os-desktop`。
  - [x] 抽出 `workflow_queries.rs`、`workflow_dto.rs` 和
        `workflow_tests.rs`；状态变更、查询投影与测试不再集中在同一文件，
        Host 不再直接调用原始 JSON 查询。
  - [x] 快照类 Worker 回执在发送成功 ACK 前校验 DTO；Ready 恢复查询跨
        Session 全量校验，损坏记录明确报错，不静默丢弃。增加正常/损坏快照
        ACK 与跨 Session 恢复测试。
  - [x] 写入快照接口、协调领取/检查点和代理决策回执已迁移为明确 DTO；
        Host/IPC 保持既有 JSON wire shape，损坏 checkpoint 在取得租约前拒绝，
        领取事件序列和 decision receipt 均有结构化解码测试。
  - [x] 决策注册、代理决策和真人回答的公开写入入参使用
        `WorkflowDecisionInput` / `WorkflowDecisionValue`；决策 kind 和部分
        领域状态仍由业务层校验，未宣称全部状态已枚举化。
  - [x] Host 工作流操作解码为显式 DTO 与 enum 分派，拒绝未知 operation、
        缺字段、类型错误和额外操作字段；默认筛选只接受省略字段。
        兼容后台入口仍只处理所属操作，计划落盘不再重复 JSON 编解码。
        证据：`crates/host/src/workflow.rs` 和 `workflow_policy.rs`，
        畸形入参不变更快照、旧 wire shape 和后台入口兼容性回归测试。
  - 边界已收敛；Storage 内部历史 JSON 状态机与部分领域状态字符串
    保留兼容，不扩大为全量重写。RPC receipt 与未知副作用对账属于 P8.5。
  - 前一切片验证：`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、
    `pnpm test`、`pnpm build`、`cargo check --workspace`、
    `cargo fmt --all -- --check` 和 `git diff --check` 均通过；
    Rust Storage 22、恢复 10、Host 35 项测试通过。本轮未提交、未 push，
    保留独立 review 点。
  - 本轮操作 DTO 切片验证：完整 `pnpm check` 通过，包含协议生成一致性、
    格式、类型、ESLint、Clippy、JS/Rust 测试与构建及 diff 检查；
    定向 `cargo test -p semi-os-host -p semi-os-storage` 通过，
    Host 43、Storage 24、恢复 10 项测试全部通过。未提交、未 push。
- [x] **P8.5 增加 RPC requestId 幂等与未知结果对账**
  - 在 Host/RPC 边界保存 request receipt、payload digest 和 reconciliation
    状态，禁止对未知副作用盲目重放。
  - inbound 持久变更回放已保存结果，digest 冲突拒绝；实时授权和租约
    重新校验。outbound `0011` 保存未发送/排队/发送中/已确认/待对账状态，
    首个字节前落盘，ACK 不等于业务完成，未知发送禁止重放。
  - 对账要求 Host 证据；不保存请求原文、凭证或实时语音，重启丢弃旧语音请求。
- [x] **P8.6 补齐跨边界契约与恢复测试**
  - 覆盖 malformed payload、重复 requestId、Worker 重启、迟到事件、
    重复工作流事件和 unknown side effect 对账。
  - 真实 Node 管道 Fixture 覆盖重复请求、崩溃重启不重放、ACK 配对；
    部分写入验证发送前落盘，失败入队可恢复，实时语音不落盘。
  - 定向 Rust 验证：Host 49、Storage 28、恢复 10 项测试通过。
    既有事件去重、旧轮次隔离、dirty worktree 与授权回归保留；
    云端、原生真人和托管 CI 验收不以 Fixture 通过替代。
  - 最终质量验证：完整 `pnpm check` 通过，覆盖 workspace 命令检查、
    协议生成一致性、Prettier/Rust fmt、TypeScript、ESLint、Clippy、
    JS/Rust 测试、JS/Rust 构建和 `git diff --check`。
    前端构建仍有大 chunk 提示，不影响本轮门禁通过；提交：
    `1a06024`。

## 输入控件接入（等待 review，未提交）

- [x] 安装 React Bits 原组件依赖，接入附件 SlingButton 源码与 CSS，
      保留弹性拖拽、回弹和发射粒子；替换文字发送按钮，保留 IME/Enter 提交。
- [x] 接入附件 VoicePill 源码与 CSS；短按开始/再次点击发送，
      长按松开发送，左滑取消；Host 转发到助手唯一 VoiceClient，
      全局快捷键同步真实采集状态，组件不重复申请麦克风。
- [x] 添加取消录音回归测试：取消不 commit、不影响下一轮，
      空闲取消不取消已提交任务；桌面端 49 项测试通过，
      桌面 typecheck 与完整 JS/Rust build 通过。
- [ ] 原生真人验证：快捷键与胶囊交替操作、权限拒绝、真实语音发送。
      浏览器布局验证不替代原生采集验收；未提交或 push。

## 浏览器结果回传修复（等待 review，未提交）

- [x] 定位浏览器已打开但 Pi 收到 `Payload must contain finite, acyclic JSON values`
      的原因：工具回执包含 `approval: undefined` 等未设置可选字段，
      Worker 将领域对象直接强转为 JSON，实际 stdout 编码时被严格校验拒绝。
- [x] Worker 事件出口显式转换 JSON：仅省略对象中的未设置字段，
      保留审批和验证信息，继续拒绝 NaN、循环引用、特殊对象和数组空位；
      不放宽协议、不重试浏览器动作、不改变工具执行及风险策略。
- [x] 调研闭环回归经过真实 Chromium、Pi Adapter、Worker 和严格 JSONL
      编解码；验证 4 次成功与 1 次登录限制回执，以及来源和报告请求。
      新增可选字段、省略不变性、审批保留和非法 JSON 拒绝测试。
      验证：Worker 全量 112 项通过；补充审批保留断言后定向 4 项通过；
      Worker typecheck、lint、变更文件 Prettier 与 `git diff --check` 通过。
      本轮未修改 Rust，未运行全仓库构建及 Rust 检查。
- [ ] 原生客户端重新运行后的真人语音/浏览器闭环复测；
      Fixture 的 Host 回执不替代真实 Rust 持久化验收。

## 调研等待与 Bash 审批修复（2026-10-23，等待 review，未提交）

- [x] 拆分确认通知与最终授权决定的 RPC 身份，保留原 operationId 关联；
      修复批准已入库但被出站账本拒绝发送、Pi 等待 120 秒超时的问题。
      Rust 账本测试与 Pi 原生 Bash 测试覆盖批准续接、拒绝阻止、
      通知 ACK 不等于授权；客户端添加提交反馈与重复点击保护。
- [x] 浏览器启动与单动作分别设置预算，默认单动作 12 秒，覆盖导航、
      条件等待和页面读取；超时关闭页面并持久化失败来源。
      Fixture 覆盖挂起导航、空正文读取、取消与执行槽释放。
- [x] 正文与页面身份原子读取，不再因广告或时钟变化误判已采集正文；
      动作引用仍受观察版本约束，登录限制继续保留 needs_user 来源。
      动态页、过期引用与受限来源回归通过。
- [x] 插话后的报告允许引用 Host 记录的同会话较早轮次证据；
      保留原来源任务身份，支持仅生成报告的任务归档与客户端来源读取。
      Rust 测试拒绝跨会话、未绑定、伪造引用及未来轮次证据。
- [x] Pi 工具 attemptId 使用全局唯一身份，避免 Runtime 重启覆盖旧回执；
      Research Skill 按问题复杂度收敛来源，明确要求先反馈进度、
      用户要求立即汇报时使用已有证据收尾，不新增 Agent Loop。
- [x] 验证：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、
      `cargo check --workspace`、Rust 格式检查与 `git diff --check` 通过。
      全仓 `pnpm check` 在格式检查处被已有的 `apps/desktop/src/styles.css`
      未格式化改动阻止；本轮未改动该文件，其余门禁分别运行通过。
- [ ] 重启原生客户端，真人验证 Bash 批准后的继续执行、插话立即汇报、
      多网站调研与实际语音耗时。本轮未重新进行云端调研计费测试，
      不承诺查询固定耗时；详细日志与验证边界见 `docs/4A-VALIDATION.md`。
      Commit：未提交，未 push。

## 对话内执行组件（2026-10-23，等待 review，未提交）

- [x] 通过 BeUI 官方 shadcn Registry 安装 AgentActivity、ToolResult、
      ToolApproval、Citations 与依赖组件；保留上游源码与动效，完成中文、
      Phosphor 图标及 unknown/needs_user 适配，保留 React Bits 输入控件。
- [x] 主对话按轮次 taskId 展示过程、工具结果、失败原因及来源。
      `execution.ts` 对 IPC 数据进行运行时校验，以幂等键关联 callId
      与 attemptId，不从模型正文推断成功，不渲染模型提供的 JSX。
      桌面端定向测试覆盖去重、未知结果、任务隔离与危险链接。
- [x] Rust Storage 提供执行只读快照；Host 持久化成功后通知客户端刷新，
      支持工具型任务恢复。来源仅包含本任务和当前报告明确引用的历史证据，
      保留原任务 Artifact 身份，不把旧来源带入普通聊天。
- [x] 操作确认移入对应轮次，区分提交中、已批准、已拒绝和送达未确认；
      批准不冒充工具成功，不提供永久授权或自动重试。
      浏览器示例页验证批准/拒绝反馈、来源展开和结果展开。
- [x] 移除普通搜索/阅读/保存报告的逐项 TTS；继续发出结构化进度，
      保留风险确认、错误和最终回答的语音路径，更新设计文档。
- [x] 增加仅 DEV 的显式 `?preview=execution` 组件预览，
      标注示例数据，隔离生产会话。验证 1440px 与 390px 页面无横向溢出；
      浏览器交互不代表真实 Host 审批或云端语音验收。
- [x] 最终全仓质量验证通过：`pnpm check`（含协议生成检查、格式、
      TypeScript、ESLint、Rust check/clippy/test、JS/Rust test、构建及
      `git diff --check`）；DEV 预览已验证 1440px/390px 无横向溢出，
      审批按钮文字对比度已修正。不提交或 push。
- [ ] 重启原生客户端，真人验证新一轮调研不逐项播报、过程实时展示、
      Bash 审批续接以及窗口重新打开后执行记录恢复。

## Ego Lite 默认浏览器适配（等待 review，未提交）

- [x] **P4A.11 提取统一浏览器后端边界**
  - `BrowserBackend` 与共享页面观察采集器隔离 Ego/Playwright 实现；
    四个既有浏览器工具、风险策略、Host 审批和来源保存不变。
  - 验证：Agent Worker 类型检查通过，既有 Playwright 浏览器与调研工作流测试通过。
- [x] **P4A.12 接入 Ego Lite TaskSpace**
  - 新增 `EgoBrowserService` 和受控 `ego-browser nodejs` Runner。Ego 操作在
    用户可见的 TaskSpace 中执行；同一 Space 串行化，引用绑定观察版本，
    点击/输入后重新观察并校验输入读回。
  - Ego CLI 取消、超时、控制权交还、过期引用和不确定 action receipt 都不
    自动重试，也不换 Playwright 重放。
  - 验证：真实本机 Ego Space fixture 完成 open、observe、fill、click、
    extract 冒烟；Ego Runner UTF-8、取消测试通过。
- [x] **P4A.13 自动选择与 Playwright 回退**
  - Worker 默认通过 `AutomaticBrowserBackend` 选择：Ego Lite 应用与
    `ego-browser` CLI 同时存在才选 Ego；Ego 未安装时使用原有 Playwright
    专属 Profile；Ego 已安装但 CLI 缺失时明确报错，不静默回退。
  - 测试：`browser-selector.test.ts` 覆盖三种选择规则；Worker 支持受控后端注入。
  - 补充：首次并发浏览器调用共享后端初始化，Worker 提前释放时会清理迟到创建的后端；
    后端动作失败不会跨驱动重放。
- [x] **P4A.14 文档与边界说明**
  - 同步 `AGENTS.md`、`docs/DESIGN.md`、`docs/DECISIONS.md`；
    关键约束为“默认 Ego、仅未安装时回退、动作不跨后端重放”。
- [ ] **P4A.15 原生客户端验收**
  - 待在已安装 Ego Lite 的用户环境启动 Semi-OS，验证真实语音调研、
    登录接管、来源持久化、确认流程和跨重启行为；完成后再提交本阶段。

### Ego 人工接管与原任务续接（等待 review，未提交）

- [x] **P4A.16 Worker 接管生命周期**
  - 原工具挂起，票据绑定 session/task，继续只恢复原 Space；新轮次、
    中断、删除会话和退出撤销旧等待及在途恢复。
- - 验证：`browser-handoff.test.ts`、`worker-service.test.ts` 通过；同一
    Pi/VoiceLoop 中恢复，未新建轮次或重放原动作。
- [x] **P4A.17 客户端继续与显式认领**
  - 结构化状态和快照；继续使用 takeover，失败后独立确认才 claim。
  - 不由 WebView 传 Space ID，不将传输 ACK 当成 Pi 已执行。
- - 验证：`BrowserHandoffPanel.tsx` 接入 `inspect/resume`，协议严格校验
    resume 票据。
- [x] **P4A.18 验证与文档**
  - 覆盖恢复、过期引用、旧票据、重复继续、取消、限制未解除、
    不确定动作不重试、Playwright 不误入 Space 恢复。
  - 原生客户端真人登录流程仍需单独验收，不以 fake 测试代替。
- - 验证：`browser-handoff.test.ts`、`ego-browser-service.test.ts`、
    `packages/protocol` 测试通过；`pnpm check` 相关子检查通过。

## 客户端白屏与协议校验修复（2026-10-25，等待 review，未提交）

- [x] 定位桌面客户端白屏根因：`packages/protocol` 在运行期调用
      `ajv.compile()`，它依赖 `new Function`，被桌面版 CSP
      `script-src 'self'` 拒绝，模块初始化抛 `EvalError`；`pnpm dev` 不发送
      CSP，因此开发模式看不到。修复方式是用 Ajv standalone 在生成阶段产出
      普通函数模块（`packages/protocol/src/generated/validators.generated.ts`），
      运行期不再需要 eval，CSP 保持不变。
      Ajv 产物里的 `require("ajv/dist/runtime/*")` 由生成器改写成 ESM 静态
      导入；共享 `$defs` 提取为独立 schema，避免每条消息内联一份（生成物
      从 2.1 MB 降到 0.52 MB）。
- [x] 回归门禁：`packages/protocol` 的测试在
      `--disallow-code-generation-from-strings` 下运行，任何重新引入运行期
      代码生成的做法都会直接失败。
- [x] 修复 Rust message registry 对可空载荷的判定：`oneOf: [{type:"null"}]`
      与 `type: ["object","null"]` 同等对待。此前
      `browser.session.snapshot` 被当成必须为对象，Worker 合法返回 `null`
      时被判非法载荷并进入重启循环（`worker.jsonl` 记录
      `response message browser.session.snapshot has an invalid payload shape`）。
- [x] 验证：`pnpm check` 全绿（protocol 8 / desktop-macos 4 / host 65 /
      storage 32+12 / protocol bin 6）；打包后 `apps/desktop/dist` 内
      `new Function` 计数为 0；`tauri build --debug` 产物启动后
      `worker.jsonl` 不再新增协议错误。客户端渲染仍需真人目视确认。
      Commit：未提交，未 push。

## Worker 启动的 Node 解析（2026-10-25，等待 review，未提交）

- [x] 定位「打包后很多功能不正常」的根因：由 launchd 启动的 `.app` 不继承
      用户 shell 的 PATH（只有 `/usr/bin:/bin:/usr/sbin:/sbin`），Host 直接
      spawn `node` 因此每次都失败并进入重启上限；`diagnostics/worker.jsonl`
      记录 `worker_spawn` 的 `No such file or directory (os error 2)`，界面
      表现为对话、语音、浏览器与桌面操控全部无反应。对照实验：同一 bundle
      二进制在 PATH 含 `/opt/homebrew/bin` 时零错误，在 GUI 默认 PATH 下
      4 次启动失败，证据确定。
- [x] `apps/desktop/src-tauri/src/node_program.rs` 按
      `SEMI_OS_NODE` → Homebrew 前缀 → nvm 版本目录（高到低）→
      登录 shell `command -v node` → PATH 扫描解析 Node 绝对路径，
      只用可执行文件命中，并配套 5 个单测。
- [x] Worker 启动失败不再中断客户端启动：原因存入 `DesktopState.worker_error`，
      由 `get_worker_status` 命令拉取、`host://worker-error` 事件补推，
      客户端挂载时直接显示「Agent Worker 未启动」；
      `RestartLimitReached` 也会通知，不再静默。
- [x] 验证：`cargo test -p semi-os-desktop` 11 passed（新增 5），
      `pnpm check` exit=0。真实验收需 `open` 打包客户端后确认
      对话与语音可用。
      Commit：未提交，未 push。

## 麦克风授权与签名身份（2026-10-25，等待 review，未提交）

- [x] 定位麦克风不可用的根因：Tauri 默认开启 hardened runtime
      （`codesign` 的 `flags=0x10002(adhoc,runtime)`），TCC 在该模式下要求签名
      携带 `com.apple.security.device.audio-input`，缺失时**不弹窗也不把应用
      列进麦克风列表**，日志为 `requires entitlement
com.apple.security.device.audio-input but it is missing` 与
      `Policy disallows prompt`。
- [x] 新增 `apps/desktop/src-tauri/entitlements.plist`（只声明该一项权限）并由
      `tauri.conf.json` 的 `bundle.macOS.entitlements` 引用；不再同时开启
      App Sandbox。
- [x] 麦克风纳入可请求闭集：`PermissionKind::Microphone` +
      `AVCaptureDevice.requestAccessForMediaType`（异步回调转为阻塞等待，
      超时不视为已授权）。原设计认为麦克风只能由采集路径请求，但 TCC 只把
      发起过请求的进程列为可授权项，导致系统设置里根本找不到应用。
- [x] 验证：`codesign -d --entitlements` 含 `audio-input`，签名 flag 仍为
      `0x10002(adhoc,runtime)`；`pnpm check` exit=0（desktop bin 11 /
      desktop-macos 4 / host 65 / protocol 8 / storage 32+12 / node_contract 1）；
      `tauri build --debug` exit=0，重新打开后 worker 无新增错误。
- [x] 旧 ad-hoc 身份问题已切换为固定证书签名；当时的 cdhash 每次重建变化，
      而 TCC 把授权绑定到授予时的代码要求，重建后旧记录不再匹配
      （证据：TCC 日志 `Failed to match existing code requirement`；四轮构建的
      cdhash 各不相同）。
- [x] 新增 `scripts/setup-code-signing-cert.sh`：生成自签代码签名证书
      （CA:false / digitalSignature / codeSigning EKU）并导入登录钥匙串。已在
      临时钥匙串端到端验证（导入 → find-identity 列出 → codesign 签名成功）。
      两个实测约束：`security import` 只接受老式 PKCS#12（RC2/3DES + SHA1
      MAC），OpenSSL 3 默认格式报 “MAC verification failed”；证书未受信任
      （CSSMERR_TP_NOT_TRUSTED）不影响签名，只需在钥匙串搜索列表内。
      `tauri.conf.json` 的 `signingIdentity` 改为 `Semi-OS Local Signing`；
      身份缺失时构建报 `Semi-OS Local Signing: no identity found`。
- [x] 指定要求稳定性已验证：同一身份签两个不同二进制，DR 均为
      `certificate root = H"8d08ab62..."`（无 cdhash）；ad-hoc 则为
      `cdhash H"..." or cdhash H"..."`。根哈希跨重建不变。
- [-] 当前真实 bundle 已验证 certificate root 固定，LaunchServices 只读
  自检及再次重建后四项权限均已授权；完整动作仍待真人验收。不例行重置
  TCC，只有确认旧记录不匹配且用户决定清理时才重置。步骤见
  `docs/4C-VALIDATION.md` 的 Ad-hoc signing and TCC identity。

## 辅助功能授权后的观察与恢复（2026-10-26，等待 review，未提交）

- [x] 前台应用改用 NSWorkspace PID 创建应用级 AX 根，同应用主窗口回退；
      错误按权限、无窗口、通信失败和前台变化分别反馈。`native.rs` 新增
      AX 错误映射测试，不能把 `CannotComplete` 等同于授权拒绝或仅指超时。
- [x] 输入监听显式恢复：重建前废弃旧租约/引用，不自动恢复暂停任务；
      权限页自动刷新不触发重建，用户“重新检查”才触发。Host 新增三个
      回归测试覆盖错误分型、监听恢复和暂停保持。
- [x] 新增客户端“只读自检”及 bundle `--desktop-diagnostic` 入口；
      不启动模型、录音或变更动作，不输出窗口正文。
- [x] 两次重建后的 LaunchServices 只读观察通过：四项权限 granted、
      监听健康、分别读取前台 Codex 11/12 个控件；固定证书指定要求已核对。
- [x] `pnpm check` exit=0（desktop-macos 5 / Host 68 /
      agent-worker 140 tests），最新 `tauri build --debug` exit=0，
      `codesign --verify --deep --strict` 通过。验收记录见
      `docs/4C-VALIDATION.md`。未提交或 push。
- [ ] 真人验收 TextEdit 启动/输入/读回、人工接管和跨重建授权；
      只读观察通过不代表以上业务动作已验收。
- [ ] 发行打包：Worker 仍依赖本地源码、Node 与依赖，尚未成为独立资源包。

- [ ] 唤醒词和自动检测说话结束。
- [ ] 微信专用适配器和消息工作流。
- [ ] 第三方 Skill/插件市场。

## MVP 之后暂缓

- [ ] MCP 生态集成。
- [ ] Windows 和 Linux 原生自动化。
- [ ] 远程执行和多设备控制。
- [ ] Dream Cycle、图记忆、复杂衰减和自动 Skill 晋升。
- [ ] 完全本地化的 STT、TTS 和 LLM Provider 组合。
