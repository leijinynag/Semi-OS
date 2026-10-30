# testing

目标路径：`tests/contract/`、`tests/integration/`、`tests/e2e/`。

## 职责

- `tests/contract/`：Rust、Node 和 UI 的协议契约测试。
- `tests/integration/`：供应商与运行时集成测试。
- `tests/e2e/`：完整应用工作流，断言证据。

## 边界

- 单元与契约测试的预期运行器是 Vitest，除非实现文档写明更合适的选择。
- 根检查使用显式命令：`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、
  `pnpm test`、`pnpm build`、`git diff --check`，以及适用的 Rust 检查。
- 负面路径与主路径同级：权限拒绝、过期目标、批准载荷变化、Worker 重启、
  断网、重复提交风险，以及无法对账的 `unknown`。
- 夹具保持合成且确定。测试通过不作为放宽工具能力的理由。
- 各模块自己的单元测试留在模块目录内。本页覆盖 `tests/` 下的三层。

## 关键依赖

- `packages/protocol`、`crates/host`、`packages/agent-worker`、
  `apps/desktop` 的公开边界。
- 验收记录补充自动测试尚未覆盖的人工路径。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 11 节
- [任务清单](../../tasks.md)
- [4A 验收](../4A-VALIDATION.md)、[4B 验收](../4B-VALIDATION.md)、
  [4C 验收](../4C-VALIDATION.md)

## 待补

- 每一层目前覆盖的场景索引。
- 仍须人工验收、不能用自动测试代替的项目。
