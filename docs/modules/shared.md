# shared

目标路径：`packages/shared/`。与运行时解耦的领域类型。

## 职责

- 放置 React 与 Node 都能使用、且不绑定某一进程运行时的领域类型。
- 用判别联合表达可共享的任务状态、工具结果和供应商事件形状。

## 边界

- 进程监督、SQLite、秘密和平台调用留在 Rust Host 或对应平台 crate。
- 供应商 SDK 调用留在供应商适配器内。
- 协议消息的事实来源是 `schemas/protocol.schema.json`。共享类型不另起
  一套平行消息定义。

## 关键依赖

- `packages/protocol`：生成并校验后的消息。
- `apps/desktop` 与 `packages/agent-worker`：类型的消费方。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 12 节
- [决策记录](../DECISIONS.md)

## 待补

- 公开类型目录。
- 与协议生成文件的分界说明。
