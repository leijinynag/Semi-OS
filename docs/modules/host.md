# host

目标路径：`crates/host/`。Rust 生命周期、策略、监督与命令。

## 职责

- 掌握应用生命周期、窗口、托盘和全局快捷键。
- 检查 macOS 权限，保管钥匙串中的秘密引用，并执行策略。
- 监督 Node Agent Worker，把 Worker 事件映射为 Tauri 事件。
- 作为特权 OS 动作和本地持久状态的权威。

## 边界

- OS 权限、原生桌面控制、策略、SQLite、秘密和进程监督以 Rust 为准。
- 其他进程通过类型化命令和事件访问数据，由 Host 打开 SQLite。
- 原生桌面变更需要新鲜观察、一次原子动作、Host 验证，以及当前
  用户批准的桌面租约。人工接管使租约和元素引用失效。
- 没有证明的已派发动作记为 `unknown`，对账之后才能重试。重启恢复保留
  该未知状态。
- 失败映射为结构化领域错误。秘密、堆栈和原始供应商载荷留在 Host 内。

## 关键依赖

- `crates/storage`：迁移、仓储和快照 DTO。
- `crates/desktop-macos`：辅助功能与屏幕观察。
- `packages/protocol`：与 Worker 的本地 JSONL RPC。
- `packages/agent-worker`：被监督的 Node 进程。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 3.2、7、8 节
- [决策记录](../DECISIONS.md)
- [4C 验收](../4C-VALIDATION.md)
- [任务清单](../../tasks.md)

## 待补

- 命令面与策略判定的公开清单。
- 重启恢复和 `unknown` 对账的操作说明。
- 交付范围以 `tasks.md` 的完成项和验收记录为准。
