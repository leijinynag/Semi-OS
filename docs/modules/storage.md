# storage

目标路径：`crates/storage/`。SQLite 模式、迁移与仓储。

## 职责

- 持有 SQLite 连接、迁移和事务边界。
- 用明确 DTO 提供工作流只读查询，以及写入后的快照。
- 保存任务事件、检查点、回执和恢复所需的持久状态。

## 边界

- 数据库只由 Rust 打开。Host 是其他进程的访问入口。
- 工作流只读查询集中在 `workflow_queries.rs`，公开接口返回
  `workflow_dto.rs` 的 DTO。原始 JSON 查询留在 Storage 内部。
- 状态变更与查询分开。工作流状态机测试留在 `workflow_tests.rs`。
- 协调领取、检查点和决策回执使用明确类型，只在 Host 或 IPC 边界
  序列化为兼容 JSON。
- 领取前校验持久检查点和事件。兼容回执先解码，再发送成功回执或发布
  到 UI。启动恢复遇到损坏记录时明确报错。

## 关键依赖

- `crates/host`：数据库的调用方和策略权威。
- `packages/protocol`：边界上的兼容 JSON，事实来源仍是协议模式。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 8、10 节
- [决策记录](../DECISIONS.md)
- [任务清单](../../tasks.md)

## 待补

- 表、迁移版本和 DTO 字段目录。
- 损坏记录与未知结果的恢复示例。
