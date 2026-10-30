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

## 待补

- 消息 kind 目录与版本策略。
- 生成命令和契约测试入口。
