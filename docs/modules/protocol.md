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
- `origin` ← origin（必填；存储层无独立列，写入来源 `note`，形如 `origin=...`，并在未指定 `kind` 时尝试映射为 `MemorySourceKind`）

可选 `operationId` 用于关联回执；缺省时 Host 使用信封 `requestId`。
回执 `status` 为 `accepted` / `stored` / `duplicate` / `rejected`，拒绝时带 `reason`。
Host 以 Agent 身份调用 `Storage::write_memory`，用户记录不会被覆盖。

## 待补

- 消息 kind 目录与版本策略。
- 生成命令和契约测试入口。
