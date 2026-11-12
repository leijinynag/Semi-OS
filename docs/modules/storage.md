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
- 六层记忆的作者门禁在 `memory.rs`。自动写入、范围检索、渐进包和会话压缩在
  `memory_access.rs`，必须经过该门禁。渐进包只提供有序材料，不组装完整提示词。
  Host 按轮次选择阶段：基础包每轮都取，上下文、搜索和 L4 只在范围或问题需要时出现。
  排序是用户明确设置、当前范围、已验证记录、置信度、最近更新、重要度。
  被替换的旧版本和冲突中落败的一侧不会和当前有效版本一起注入。
  压缩摘要只经 `compact_session` 写入 L0，不走会拒绝 L0 的 `write_memory`。
  紧凑人格只读 `personality_records` 的当前生效版本，组装过程不改作者约束。
  P5.11 的 `memory.candidate.submit` 由 Host 映射到 `MemoryWriteCandidate` 后走
  `write_memory`；SQLite 仍只由 Rust Host 打开。`origin` 写入来源备注，不新增列。
  P5.12 的明确纠正同样走 `write_memory`，但调用者是用户身份：新行不覆盖旧行，
  只用 supersedes / contradicts 关联；已被 supersede 的等价正文不阻止用户再写
  回旧值。渐进包对同键偏好只保留用户优先的有效版本。
  P5.14 的已验证经验仍由 Host 把 `memory.candidate.submit` 映射进 `write_memory`。
  秘密过滤和作者门禁不变；失败或 unknown 的来源证明在映射前就被拒绝。

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
