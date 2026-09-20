import type {
  ClientSettings,
  ConversationMessage,
  MemoryItem,
  SkillItem,
  TaskTimelineModel,
} from "./client-model";

/**
 * 2D 阶段尚未接入 Host 状态投影，因此这里集中维护可替换的类型化样例数据。
 * 页面组件只消费领域模型；后续接入 IPC 时可直接替换数据源，而无需重写展示逻辑。
 */
export const conversationFixture: readonly ConversationMessage[] = [
  {
    id: "message-1",
    author: "user",
    content: "帮我调研主流 Agent 的记忆系统，并整理一份结论。",
    time: "09:42",
  },
  {
    id: "message-2",
    author: "assistant",
    content: "收到。我会比较存储结构、写入策略和渐进式召回方式，完成后先语音汇报重点。",
    time: "09:42",
  },
  {
    id: "message-3",
    author: "assistant",
    content: "已完成 6 个来源的交叉整理，正在核对引用并生成结果。",
    time: "09:48",
  },
];

export const taskFixtures: readonly TaskTimelineModel[] = [
  {
    id: "task-memory-research",
    title: "调研 Agent 记忆系统",
    status: "running",
    summary: "比较 Hermes、Lumi 与 Claude Code 的记忆和压缩策略。",
    currentAction: "核对来源并整理渐进式加载差异",
    startedAt: "今天 09:42",
    updatedAt: "刚刚",
    milestones: [
      {
        id: "milestone-1",
        title: "理解目标",
        detail: "已确认聚焦存什么、怎么存、怎么读。",
        status: "completed",
        occurredAt: "09:42",
      },
      {
        id: "milestone-2",
        title: "收集资料",
        detail: "已读取 6 个官方仓库和设计文档。",
        status: "completed",
        occurredAt: "09:47",
      },
      {
        id: "milestone-3",
        title: "交叉分析",
        detail: "正在比较长期记忆与会话压缩的职责边界。",
        status: "active",
        occurredAt: "09:48",
      },
      {
        id: "milestone-4",
        title: "汇报结果",
        detail: "等待分析完成后生成语音摘要。",
        status: "pending",
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        label: "来源清单",
        reference: "artifact://research/source-index",
        kind: "artifact",
      },
      {
        id: "evidence-2",
        label: "检索结果快照",
        reference: "artifact://research/browser-captures",
        kind: "verification",
      },
    ],
  },
  {
    id: "task-project-update",
    title: "更新本地项目依赖",
    status: "waiting_confirmation",
    summary: "检查依赖版本并准备执行会修改工作区的安装命令。",
    currentAction: "等待执行 pnpm install",
    waitingReason: "该操作会写入 lockfile，需要确认目标工作区和命令内容。",
    startedAt: "昨天 16:20",
    updatedAt: "昨天 16:23",
    milestones: [
      {
        id: "milestone-5",
        title: "检查项目",
        detail: "识别为 pnpm workspace。",
        status: "completed",
        occurredAt: "16:20",
      },
      {
        id: "milestone-6",
        title: "生成变更计划",
        detail: "已选择兼容当前 Node 版本的依赖范围。",
        status: "completed",
        occurredAt: "16:22",
      },
      {
        id: "milestone-7",
        title: "执行安装",
        detail: "等待用户确认本地写入。",
        status: "waiting",
        occurredAt: "16:23",
      },
    ],
    evidence: [],
  },
  {
    id: "task-lark-summary",
    title: "整理飞书会议纪要",
    status: "completed",
    summary: "提炼会议结论并写入指定飞书文档。",
    result: "已写入 8 条结论和 4 个待办，并通过重新读取验证。",
    startedAt: "9 月 17 日 14:05",
    updatedAt: "9 月 17 日 14:12",
    milestones: [
      {
        id: "milestone-8",
        title: "读取会议内容",
        detail: "成功读取目标文档。",
        status: "completed",
        occurredAt: "14:06",
      },
      {
        id: "milestone-9",
        title: "整理纪要",
        detail: "完成结论、负责人和截止时间提取。",
        status: "completed",
        occurredAt: "14:09",
      },
      {
        id: "milestone-10",
        title: "写入并验证",
        detail: "写入成功，内容回读一致。",
        status: "completed",
        occurredAt: "14:12",
      },
    ],
    evidence: [
      {
        id: "evidence-3",
        label: "飞书文档",
        reference: "lark://document/meeting-summary",
        kind: "source",
      },
      {
        id: "evidence-4",
        label: "写入验证",
        reference: "receipt://tool/lark-write-018",
        kind: "verification",
      },
    ],
  },
];

export const memoryFixtures: readonly MemoryItem[] = [
  {
    id: "memory-1",
    title: "沟通偏好",
    content: "优先讨论重要决策，细节在实现过程中探索；避免重复询问已确认事项。",
    layer: "L1 常驻规则",
    source: "user",
    updatedAt: "用户创建 · 9 月 18 日",
  },
  {
    id: "memory-2",
    title: "项目技术栈",
    content: "Semi-OS 使用 Tauri、React、TypeScript、Rust Host 和 Node Agent Worker。",
    layer: "L2 整理记忆",
    source: "agent",
    updatedAt: "Agent 更新 · 今天",
  },
  {
    id: "memory-3",
    title: "任务执行偏好",
    content: "低风险读取与本地写入默认自动执行，外部副作用默认需要确认。",
    layer: "L1 常驻规则",
    source: "user",
    updatedAt: "用户创建 · 9 月 15 日",
  },
];

export const skillFixtures: readonly SkillItem[] = [
  {
    id: "skill-research",
    name: "深度调研",
    description: "跨网站收集资料、记录来源并生成结构化分析。",
    category: "研究",
    availability: "ready",
    toolCount: 4,
  },
  {
    id: "skill-coding",
    name: "Coding Agent",
    description: "通过统一终端适配层启动、观察和引导本地编码任务。",
    category: "开发",
    availability: "ready",
    toolCount: 5,
  },
  {
    id: "skill-desktop",
    name: "桌面操作",
    description: "观察窗口并执行受约束的点击、输入和应用切换。",
    category: "系统",
    availability: "permission_required",
    toolCount: 7,
  },
  {
    id: "skill-lark",
    name: "飞书操作",
    description: "通过 Lark CLI 读取、创建和更新协作文档。",
    category: "协作",
    availability: "ready",
    toolCount: 3,
  },
];

export const settingsFixture: ClientSettings = {
  personality: "沉稳、直接、善于把复杂任务拆成清晰步骤。",
  voiceReply: true,
  floatingConfirmation: true,
  confirmHighRisk: true,
  confirmExternalSideEffect: true,
};
