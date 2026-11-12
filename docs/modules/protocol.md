# protocol

目标路径：`packages/protocol/`。共享的版本化协议模式与生成类型。

## 职责

- 承载由单一模式生成的消息类型和运行时校验。
- 在进程边界上使用判别联合表达协议消息、任务状态、工具结果和供应商事件。

## 边界

- `schemas/protocol.schema.json` 是协议的唯一事实来源。
- 进程边界拒绝未知 kind、畸形载荷和不支持的协议版本。
- Rust 与 TypeScript 的消息形状从该模式生成，避免平行的手写定义。
- 外部 JSON 视为不可信输入。
- RPC 重试复用同一个 `requestId`。入站持久操作可以对相同载荷摘要重放
  已保存结果；摘要冲突必须拒绝。
- 出站回执记录传输确认。写管道字节之前先持久化 `sending`，中断的发送
  在重试前对账。
- 实时 `voice.*` 流量不进入持久出站账本。音频和凭证不写入该账本。

## 关键依赖

- `schemas/protocol.schema.json`。
- `crates/host` 与 `packages/agent-worker` 的 JSONL RPC。
- `apps/desktop` 消费的结构化事件。
- `tests/contract`：跨 Rust、Node 和 UI 的契约测试。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 3.4 节
- [决策记录](../DECISIONS.md)
- [任务清单](../../tasks.md)

## 记忆候选（P5.11）

Worker 通过事件 `memory.candidate.submit` 向 Host 提交结构化候选；Host 校验后
以请求 `memory.candidate.result` 回执，Worker 再响应 `memory.candidate.received`。

协议 JSON 使用现有协议的 camelCase，对应产品字段：

- `memoryId` ← memory_id
- `recordKind` ← record_kind
- `layer` ← layer
- `content` ← content（`MemoryBody` 对象，必须带 `kind`，不能只传无类型字符串）
- `scope` ← scope
- `confidence` ← confidence（0–100）
- `importance` ← importance（0–100）
- `sourceRefs` ← source_refs（数组，元素至少包含 `sourceRef`）
- `conflictTarget` ← conflict_target（对象或 `null`，字段本身必填）
- `origin` ← origin（必填；只写入来源 `note`，形如 `origin=...`，不映射为 `MemorySourceKind`。`user_entry` / `user` 等冒充用户来源的值会被拒绝。L2 自动写入仍是 `preference` / `project_fact`；P5.14 另接受带来源证明的 L3/L5 经验）

可选 `operationId` 用于关联回执；缺省时 Host 使用信封 `requestId`。
回执 `status` 为 `accepted` / `stored` / `duplicate` / `rejected`，拒绝时带 `reason`。
Host 以 Agent 身份调用 `Storage::write_memory`，用户记录不会被覆盖。
P5.11 只自动接受 L2 `preference` / `project_fact`。P5.14 不新增 kind，沿用同一提交写入已验证的
L3 `task_summary` / `verified_outcome` 和 L5 `workflow_candidate`。`origin` 必须是
`verified_experience`，来源备注要带 `completion=completed` 或
`status=succeeded` + `verification=passed` + 非模型的 `method`。失败、unknown、
未验证和 `method=model_prose` 返回 `unverified_experience`，不落库。
`skill_candidate` 仍然拒绝，避免这条路径自动晋升 Skill。

## 用户纠正（P5.12）

Host 在已有用户原文上做确定性识别，不新增协议 kind，也不改 Pi loop：

- `voice.text.submit` 在转发 Worker 之前写入，本轮 `memoryContext` 即可用上新偏好。
- `voice.transcript.final` 在转写完成后写入，避免挡首句语音；下一轮注入生效。

写入以用户作者走 `write_memory` / `memory_links`，旧记录保留。

## 运行时范围召回（P5.13）

Host 仍把结果写入已有的 `memoryContext`，不新增协议 kind，也不改 Pi loop。
`voice.text.submit` 在转发前按原文决定基础、上下文、搜索和深读。
`voice.turn.start` 还没有转写，只附基础包，避免挡住首句，也不提前搜索项目记忆。
工作区、应用、任务和 Skill 来自轮次上的当前范围；闲聊即使带了这些字段也不召回项目记忆。

## 已验证经验（P5.14）

Worker 在 `voice.sentence`、`voice.answer` 和 `voice.turn.completed` 已经送出之后，
才根据结构化工具回执、完成状态和任务摘要生成 L3/L5 候选，并后台提交
`memory.candidate.submit`。提交不在首句或本轮结果的返回路径上等待。
失败和 unknown 回执不会生成可执行的 `workflow_candidate` 或 `verified_outcome`。
记忆范围绑定用户和工作区，不绑定刚结束的任务编号，这样下一轮任务还能召回。

## 待补

- 消息 kind 目录与版本策略。
- 生成命令和契约测试入口。
