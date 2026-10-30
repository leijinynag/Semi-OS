# agent-worker

目标路径：`packages/agent-worker/`。Node Worker、Pi 适配与编排。

## 职责

- 经 `AgentRuntimeAdapter` 持有前台 Pi 会话。已批准的工作流使用同一
  适配器后的独立持久协调会话。
- 编排语音供应商、动态工具、Skills、浏览器适配器和 Coding Agent 子进程。
- 把模型事件译成领域事件，并把特权动作交给 Host。

## 边界

- 有意义的用户回合进入前台 Pi 会话。后台协调不依赖语音，也不打断普通对话。
- Pi 留在适配器之后。复用 Pi 原生的文件和 shell 工具；Semi-OS 工具只在
  Pi 不拥有该能力，或 Host 策略边界要求时增加。
- 后台 Pi 只使用所属工作流的协作工具。
- 浏览器使用有界工具。Ego Lite 在其应用和 `ego-browser` CLI 已安装时
  作为用户可见后端；未安装时才使用 Playwright 专用配置档。
- 可能已经生效的动作不因通信重试而重放。不确定的外部结果是 `unknown`。
- 空事件领取不调用模型。三轮无进展，或同一问题三轮返工，转为 `needs_user`。

## 关键依赖

- `packages/protocol`：本地 JSONL RPC。
- `packages/tool-sdk`：工具契约与回执。
- `packages/skills`：内置受信任技能。
- `packages/shared`：运行时中立的领域类型。
- `crates/host`：特权动作、策略和持久状态。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 3.3、4、5、6 节
- [4A 验收](../4A-VALIDATION.md)
- [4B 验收](../4B-VALIDATION.md)
- [任务清单](../../tasks.md)

## 待补

- 适配器、供应商和子进程的接口清单。
- 后台无进展转 `needs_user` 的操作说明。
- 验收记录中仍标为人工或未完成的路径。
