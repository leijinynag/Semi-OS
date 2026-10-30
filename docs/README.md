# Semi-OS 文档索引

本页汇总 `docs/` 中的设计、验收和模块说明，并指向仓库协作入口。
模块页记录 `AGENTS.md` 规定的目标边界与所有权。某项能力是否已经交付，
以 `tasks.md` 和对应验收记录为准。

## 设计与决策

- [详细设计](DESIGN.md)
- [决策记录](DECISIONS.md)
- [架构图](assets/architecture/)
- [桌面助手原型](assets/prototype/desktop-assistant.png)
- [客户端原型](assets/prototype/client.png)
- [飞书发布源](feishu/semi-os-design.xml)

## 验收与验证

- [4A 资料调研工作流](4A-VALIDATION.md)
- [4B 多 Agent 协作](4B-VALIDATION.md)
- [4C 原生桌面与 Lark](4C-VALIDATION.md)（本轮最小演示过线以该文 2026-10-30 定稿为准）
- [阶段 5 记忆、人格与用户偏好](5-VALIDATION.md)
- [Session 管理](SESSION-VALIDATION.md)
- [桌面助手与语音交互优化](VOICE-OPTIMIZATION-VALIDATION.md)
- [真人录音评测](VOICE-HUMAN-CORPUS.md)

## 模块说明

下列页面是骨架。它们说明目标路径、职责和必须保持的边界，不代替实现清单。

- [desktop](modules/desktop.md)：React UI 与 Tauri 入口
- [host](modules/host.md)：Rust 生命周期、策略、监督与命令
- [desktop-macos](modules/desktop-macos.md)：macOS 辅助功能与屏幕观察
- [storage](modules/storage.md)：SQLite 模式、迁移与仓储
- [agent-worker](modules/agent-worker.md)：Node Worker、Pi 适配与编排
- [protocol](modules/protocol.md)：版本化协议模式与生成类型
- [tool-sdk](modules/tool-sdk.md)：工具契约、回执与验证类型
- [skills](modules/skills.md)：内置受信任 Skills
- [shared](modules/shared.md)：与运行时解耦的领域类型
- [testing](modules/testing.md)：契约、集成与端到端测试

## 协作入口

- [仓库说明](../README.md)
- [贡献者与编码代理规范](../AGENTS.md)
- [MVP 任务清单](../tasks.md)
