# BeUI Registry 组件

通过官方 shadcn Registry 安装，保留真实组件源码与动效，不是仿制组件。

```sh
pnpm dlx shadcn@4.22.1 add @beui/agent-activity @beui/tool-result @beui/tool-approval @beui/citations
```

来源：BeUI / starc007/ui-components，MIT License。
Registry：`https://beui.dev/r/{name}.json`。

本地适配：中文文案、Phosphor 图标映射、8px 容器圆角、
`unknown`/`needs_user` 工具结果呈现。业务数据与策略不进入这些组件；
由 `ui/execution.ts` 和 `ui/TurnExecution.tsx` 将 Host 状态映射到展示属性。
不展示推理，不自动重试，不提供当前策略未支持的永久授权。
