# skills

目标路径：`packages/skills/`。内置受信任 Skills。

## 职责

- 存放随应用发布的内置受信任技能：声明式指引，以及可选的脚本和资源。
- 按意图、应用、领域和工具需求形成候选，只加载被选中技能的详细说明。

## 边界

- MVP 技能内置，并随应用发布建立信任。第三方插件不在当前基线内。
- 优先使用 Pi 的原生资源加载。Semi-OS 若增加登记层，只补充元数据、
  信任和兼容规则。
- 技能不能把后台工作流扩大到前台文件和 shell 工具。
- 用户编写的人格与偏好对 Agent 只读。Agent 只能改写策略允许的、
  由 Agent 自己编写的记录。

## 关键依赖

- `packages/agent-worker`：候选匹配、选择与注入。
- `packages/tool-sdk`：技能所要求的工具契约。

## 权威文档

- [AGENTS.md](../../AGENTS.md)
- [详细设计](../DESIGN.md) 第 4.3 节
- [决策记录](../DECISIONS.md)
- 包内说明：`packages/skills/research/SKILL.md`、
  `packages/skills/desktop/SKILL.md`、
  `packages/skills/collaboration/SKILL.md`

## 待补

- 信任、签名和兼容规则的说明。
- 选择步骤与提示注入预算。
- 哪些技能说明已经随构建发布，以 `tasks.md` 为准。
