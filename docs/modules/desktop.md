# desktop

目标路径：`apps/desktop/`。React UI 与 Tauri 入口。

## 职责

- 渲染桌面助手和客户端，消费结构化事件与快照。
- 提交用户意图，包括按住说话、确认、暂停、继续和取消。
- 为加载、空、错误、暂停、取消和确认状态提供明确渲染。

## 边界

- React 渲染状态并发出用户意图。特权操作留在 Rust Host。
- 任务是否成功、失败或等待，只来自结构化事件和快照。
- 桌面助手与客户端是分开的界面，共享领域状态。
- 粒子、波形和中心光球是展示效果，任务语义留在领域状态。
- 标准图标经本地语义适配层使用。React Bits 输入控件留在
  `ui/react-bits/`；语音控件沿用既有采集器。

## 关键依赖

- `crates/host`：Tauri 命令与事件。
- `packages/protocol`、`packages/shared`：界面消费的消息和领域类型。
- 设计基线见 `docs/DESIGN.md` 第 3.1 节。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md)
- [决策记录](../DECISIONS.md)
- [任务清单](../../tasks.md)
- [语音优化验收](../VOICE-OPTIMIZATION-VALIDATION.md)

## 待补

- 窗口、托盘和全局快捷键的交付对照。
- 组件目录与状态投影的阅读入口。
- 与语音、Session 验收记录的逐项对应。
