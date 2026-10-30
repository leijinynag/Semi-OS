# Semi-OS Decision Log

This file records confirmed product decisions separately from proposals.

## 2026-10-13：架构加固原则

### 2026-10-14：已落地边界与验证范围

- 协议字段级 schema 生成 TypeScript 判别联合、Rust DTO 与运行时校验资源；
  Worker 使用穷尽 switch 分派，生成一致性进入 `pnpm check`。
- research/workflow 的持久化、回执构造与业务副作用移入 Host 模块；
  桌面 router 保留 UI 投递和依赖组装，既有 IPC 字符串错误入口兼容保留。
- inbound receipt 回放业务结果；outbound ledger 只证明传输接收，
  不能把 ACK 当作任务成功。出站请求在写入第一个字节前持久化 `sending`，
  写入中断和进程崩溃必须先对账，不自动重发可能已执行的操作。
- outbound 使用独立 Storage 连接，避免回执写入重入业务数据库锁；
  不保存请求原文、凭证或 PCM，实时 `voice.*` 不进入持久账本。
- 未发送、排队、发送中、已确认和待对账分别保存；digest 冲突明确拒绝。
  对账仅由 Host 依据非空证据执行，不允许 Agent 自证未知操作成功。
- 已补真实 Node 子进程崩溃/重启、重复发送、部分管道写入、失败入队、
  非法 ACK、实时语音丢弃测试。托管 CI 与真人原生体验仍须独立验收，
  不因本地质量门禁通过宣称已完成。

- 质量门禁使用 ESLint Flat Config、Prettier、TypeScript 检查以及 Rust
  fmt/check/test/clippy；根命令不使用 `--if-present` 静默跳过关键 workspace。
- `schemas/protocol.schema.json` 是协议唯一事实来源。协议类型和运行时校验
  按消息 kind 渐进覆盖，未知 kind、错误 payload 和未来不支持版本明确拒绝。
- 现有历史文件使用 Prettier baseline 控制首次引入工具的 diff；新增或修改
  文件必须进入格式检查，不进行无关的全仓库格式化。
- Host 拆分采用兼容式迁移，先抽取纯路由和 HostError，再逐步减少 `main.rs`
  中的业务逻辑；不一次性重写 Tauri 组装入口。
- Storage 对外使用 DTO，内部 JSON 仅用于数据库兼容字段；已执行 migration
  保留不改写，conversation migration 属于历史演进。
- requestId 幂等和未知结果对账属于 Host/RPC 边界职责，不下沉到具体工具。
- Host 拆分先从无界面的生命周期路由开始。`HostError` 提供稳定的 UI 安全
  文案，Tauri 入口在迁移期间保留 `String` 兼容层；voice、research 和
  workflow 路由在后续切片中逐步迁移，不进行一次性重写。
- voice 事件采用纯函数先更新并校验会话快照，再由 Tauri 入口执行低频持久化
  和 UI 广播；research 事件采用同样的纯分类边界。旧 request、跨会话身份和
  畸形 payload 必须在进入 Storage 或 WebView 前被忽略或拒绝，迁移期间保留
  原有 Worker 回执和 Tauri IPC 兼容层。
- P8.4 的工作流查询出口采用 typed DTO。为兼容既有 Worker 操作和历史 migration，
  保留 JSON 内部状态机，但快照在 UI 发布、Ready 恢复、运行核对和 Policy 授权
  前必须完成 DTO 解码；不重写历史 migration。
- 工作流只读实现抽至 `workflow_queries.rs`，原始 JSON 查询限制为 crate 内部；
  DTO 与状态机测试分别独立维护。写入回执在 Storage 内返回快照 DTO，Host/IPC
  只在边界序列化为兼容的 JSON；协调领取、检查点和代理决策也使用显式 DTO
  discriminator，不能以任意 `Value` 表示成功、未领取或未知结果。启动恢复
  不再静默跳过损坏记录：先校验全部会话，失败时显示恢复错误，不通知 Worker
  消费部分结果。P8.5 的 inbound/outbound 回执分离，传输确认不替代领域验收。
- 工作流操作在 Host 解码成显式 DTO 后以 enum 分派；wire schema 仍是唯一
  协议来源，内部 DTO 只表达领域执行参数。保留既有 JSON 入口兼容桥，
  非后台操作仍由旧后台入口返回 `None`，不能在迁移中抢占其他路由。
  畸形参数报告具体 operation 与解码原因；外层 UI 继续使用安全错误映射。
  计划解码后直接验证与落盘，不做重复 JSON 往返。

## Confirmed

| Area                        | Decision                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product                     | Voice-controlled computer assistant, not a chat client with voice added                                                                                                   |
| MVP scenarios               | Multi-site research and voice briefing; coding-agent delegation; generic application/Lark CLI operations                                                                  |
| Desktop shell               | Tauri + React + TypeScript                                                                                                                                                |
| Native host                 | Rust owns windows, permissions, shortcuts, OS automation, secrets and SQLite                                                                                              |
| Agent process               | A supervised Node.js worker embeds Pi through an adapter                                                                                                                  |
| Agent loop                  | All meaningful tasks pass through Pi; no separate “simple-task agent”                                                                                                     |
| Runtime extension           | Prefer Pi SDK/extensions; MCP is a later interoperability layer                                                                                                           |
| Tools                       | Dynamically expose only tools currently allowed and available                                                                                                             |
| Browser                     | Prefer Ego Lite and its user-visible TaskSpace when installed; use dedicated-profile Playwright only when Ego Lite is not installed                                       |
| Native automation           | macOS first; semantic accessibility lookup, screenshot/vision fallback                                                                                                    |
| Action granularity          | Fresh observation, one atomic action, structured verification                                                                                                             |
| Voice trigger               | Push-to-talk in MVP; reserve an automatic wake/VAD branch                                                                                                                 |
| Voice response              | No universal acknowledgement or routine stage narration; inline execution UI, spoken confirmations/errors and final answers                                               |
| Speech providers            | Cloud-first behind STT/TTS provider interfaces; local providers can replace them                                                                                          |
| Interruption                | Pause/abort current work and inject steering into the continued Pi session                                                                                                |
| Floating UI                 | Visible only while hotkey is held, task is running, or confirmation is required                                                                                           |
| Confirmation UI             | Voice announcement plus real client confirmation controls; Host retains approval authority                                                                                |
| Risk policy                 | `read` and `local_write` auto-run by default; `external_side_effect` confirms                                                                                             |
| Policy settings             | Low/high risk defaults are configurable, but high-risk tools default to confirmation                                                                                      |
| Network failure             | Limited retry before side effects; uncertain side effects become `unknown`                                                                                                |
| Skills                      | Candidate matching plus final Agent judgment; built-in only in MVP                                                                                                        |
| Skill contents              | Skills may include scripts and multi-step workflows                                                                                                                       |
| Plugins                     | Extension entry is reserved; MVP loads built-in trusted plugins only                                                                                                      |
| Memory                      | MVP uses a separate six-layer memory subsystem; normal low-risk memories are written automatically without user confirmation                                              |
| Memory compaction           | MVP uses simple threshold-based Pi session compaction; compaction summary is working context, not long-term memory                                                        |
| Progressive memory loading  | Load a compact base pack first, then retrieve deeper memory and evidence on demand                                                                                        |
| Agent personality           | Personality is a versioned runtime context layer for identity, tone, behavior and voice; it is separate from user facts and memory evidence                               |
| Permissions                 | First-run macOS permission center; missing permission degrades capabilities                                                                                               |
| Client UI                   | Conversation, tasks, memory, skills and settings; simplified user-facing timeline                                                                                         |
| Task complexity             | Do not pre-classify turns with a separate complexity classifier; execution-tool use creates or continues a visible TaskRun, while memory recall alone does not            |
| User interruption           | Let the Agent decide whether an interruption steers, pauses/cancels or starts a new task; preserve the same session and task evidence                                     |
| Research workflow           | MVP supports multi-site collection, synthesis, source recording and voice briefing                                                                                        |
| Application workflow        | MVP supports generic app launch/focus and bounded desktop operations; Lark CLI is supported where an operation has a stable command path                                  |
| WeChat                      | Defer WeChat-specific automation; it is not an MVP acceptance blocker                                                                                                     |
| MVP implementation strategy | Research, Coding Agent delegation and generic application operation may be implemented in parallel; they share the same voice, Pi, TaskRun, tool and evidence foundations |
| Coding Agent transport      | Use a common PTY-like local terminal adapter first; provider-specific differences are isolated to launch, output parsing, steering, resume and result collection          |
| Initial providers           | STT, TTS and LLM use cloud providers in the first release, behind replaceable provider interfaces                                                                         |
| Progress UI                 | Show a simple event-driven task timeline with current step, recent action, waiting reason and result                                                                      |
| Assistant visuals           | Use expressive mouse-following, particle and speech-wave effects; animation is presentation-only and does not define task semantics                                       |
| Personality and preferences | User may manually edit personality and user preferences; the Agent may append or revise only Agent-created memories and cannot mutate user-authored entries               |
| Overlay rendering           | Transparent, shadowless, nonfocusing and mouse-passthrough native window; only 3D halo and particles, no visible text                                                     |
| Speech synchronization      | Prefer validated word timestamps and actual playback position; fallback reveals a sentence on actual playback start                                                       |
| Answer format               | Required speech with optional Markdown details; simple replies have no duplicate report                                                                                   |
| Streaming recognition       | Persistent local microphone gate; only final transcription enters Pi; current Fun default retained pending human comparison                                               |
| Text input                  | Client chat bypasses only capture/STT; uses the same Pi session, tools, confirmations, TTS, playback synchronization and history                                          |

### Browser backend selection

Semi-OS keeps one stable set of bounded browser tools (`browser_open`,
`browser_click`, `browser_type` and `browser_extract`) while selecting the
implementation inside the Worker:

- If the Ego Lite application and its `ego-browser` CLI are both detected, Ego
  is the default. Each Worker browser service owns one uniquely named
  TaskSpace, so the user can see the Agent's pages and actions in Ego Lite.
- If Ego Lite is not installed, the Worker falls back to Playwright with a
  Semi-OS-owned persistent profile.
- If Ego Lite is installed but its CLI is missing, or if Ego cannot connect,
  control the Space, or verify an action, the operation fails visibly. It must
  not silently fall back or replay the action in Playwright because the action
  may already have taken effect.
- The Agent does not receive arbitrary browser scripts. Both implementations
  are behind the same observation-version, risk, approval, verification and
  source-capture contracts.

### Ego 人工接管恢复

- Ego 保存登录态；遇到限制时交还原 Space，不删除登录状态或新建浏览器。
- 采用挂起原工具 Promise 的方式保留 Pi 任务栈。用户点击客户端继续后，
  恢复原 Space，刷新观察再返回原工具；不向新一轮对话重复发送原始动作。
- Worker 签发一次性接管票据，绑定会话/任务；UI 只能提交票据，
  不能指定任意 Space。传输接受回执不等于恢复成功，结果以结构化事件为准。
- 默认 takeover；claim 仅在用户独立明确确认后可用。限制未解除则继续等待，
  取消/新任务撤销旧票据。旧元素引用与旧审批不能跨人工接管复用。
- 此状态为 Worker 内存态，重启不自动抢回浏览器；不将 unknown 动作当作
  可继续的登录等待。

## 2026-10-11：客户端 Session 与轮次区分

- 一个 Session 包含多轮对话和任务；普通消息不能自动新增左侧 Session，
  只有用户手动新建会话才应增加条目。
- SQLite 维护真实 Session 列表和唯一 active 选择，空会话也持久化。
  迁移将已有轮次的归档归属统一映射到“默认会话”，原始 JSON 中的旧运行身份
  保留；不按 taskId 拆分，也不把历史合并宣称为 Pi 上下文恢复。
- 左侧顶部新建图标先弹窗命名，再手动创建并切换；用户指定的名字不会被消息覆盖。
  已有会话右键可重命名或删除，删除需确认；删除当前会话切换到其他会话，
  删除最后一个会话时创建新的空白会话。删除移除会话聊天归档与 Worker 上下文，
  不级联清理独立的任务回执、调研证据或浏览器 Profile。
  助手唯一控制器停止旧录音和播报，通过现有队列发出暂停，再由 Host 提交选择；
  切换期间禁止文字/语音开始新轮次，过期切换回执不能改变 active。
- Worker 按 Session 懒加载独立 VoiceLoop/Pi Adapter，并在同一 Worker 生命周期
  内复用；切回后继续原 Pi 上下文，非 active 会话的迟到语音事件不发送。
  不实现第二套 Agent Loop，也不隔离浏览器 Profile。
- 重启后恢复会话列表、选择与文字归档，不恢复 Pi 的内存上下文；
  跨 Worker 重启的 Checkpoint 恢复仍为后续能力。当前归档接口最多返回最近
  200 轮（所有会话合计），分页与更早历史读取后续补齐。
- 切换失败不自动重试，重新读取 Host 权威列表；已创建但未成功激活的空会话
  保留，用户可再次选择，避免未知结果导致重复创建。
- 主内容区不显示滚动条，保留正常滚动和对话刻度跳转。

## 2026-10-10：客户端文字对话与统一输入链路

- 增加多行消息框；Enter 发送、Shift+Enter 换行，中文输入法选词不触发发送。
  保留 Markdown 回答、可选详情和来源；历史按时间正序，不伪造对话 Fixture。
- React 只提交意图，Host 校验并定向转发给助手唯一控制器。
  `voice.text.submit` 仅绕过音频采集/STT，之后仍进入已有 VoiceLoop/Pi。
  不新增文字 Agent Loop，不改变有声媒体出口或 Host 风险确认边界。
- 两种输入共用 Host 会话身份、工具、TTS、同步文字与保存逻辑。
  麦克风关闭、拒绝和未决授权不影响文字；迟到预热错误不能覆盖新轮次。
- 新输入停止旧音频/录音并暂停旧任务，不额外提交被替换的录音。
  草稿仅在控制器完成 Worker 传输后清空，等待期间的新编辑保留；
  失败或未知接收结果不自动重发，避免重复工具副作用。
- 本轮实现与自动测试完成，真实原生云端回复/听音仍需验收；未经 review
  不提交或 push。详细证据见语音验收文档 PV.20。

## 2026-10-08：常驻采集、通用身份与声音动效

- 默认本地预热设备，空闲采样立即丢弃；设置可关闭预热和语音。
  麦克风系统指示持续出现，不能把“无上传”说成“未使用麦克风”。
  每轮 token/缓冲/序号独立；网络串行不阻塞下一轮本地采集。
- 产品系统提示由 Pi 官方 Loader 替换并显式 reload；运行 cwd 与开发仓库
  隔离，个人 packages/扩展/开发上下文不自动加载。保留模型认证、原生
  工具、Host 策略扩展及内置 Skills。不新增分类调用或第二个 Agent Loop。
- speech 必需，Markdown 仅调研、复杂分析或用户要求时生成；无详情不复制
  摘要。新会话生效，保留旧记录，干净会话验收。
- Fun 专用 vocabulary_id 配置入口；网关兼容性和词表实际效果待实测。
  评测脚本支持至少 30 条真人同录音，未有真人语料前保持默认模型。
- 保留直接媒体 WAV 出口，PCM 包络与实际 currentTime 驱动 GPU 动效；
  绝不为了可视化重接 WebAudio。暂停/取消归零，减少动态设置关闭声振。
- 数值阶段计时由 Host 白名单验证并保存，P50/P95 按同轮次同阶段统计，
  不保存声音/文字/凭证，不把 Worker 首包等同于真实出声。
- 本节替代下方历史记录中的借用采集上下文、提交后排队采集、固定报告、
  以及直接媒体路径无法获取音量等描述。原生真人验收独立记录，未提交。

## 2026-10-07：桌面与语音交互优化

- 悬浮助手仍由 Tauri 透明窗口承载，无阴影、不主动聚焦、默认鼠标穿透。
  页面只绘制光环和粒子；真实确认留在客户端，Host 授权边界不变。
  鼠标穿透下不承诺 WebView 能直接接收桌面鼠标移动。
- 助手 WebView 独占采集与播放，不依赖 React 组件是否挂载；
  客户端订阅带版本的 Host 快照，重开恢复最终文字而非旧播放位置。
- （本条生命周期规则由上方 2026-10-11 手动 Session 管理取代。）
  Host 存活期间保持首个语音会话身份，录音控制器必须使用
  `start_voice_conversation` 返回的 session ID；页面重载只创建新录音轮次，
  不更换 Worker 已持有的 Pi Session。跨 Host 重启的 Pi 会话恢复仍属后续工作。
- 移除统一回应；阶段变化、风险确认和错误反馈保留，完整报告默认不朗读。
  模型漏写可播报标记时，在本轮结束后从最终 post-tool 回答保守取一句，
  过滤内部分析、代码和引用标识；不能把工具前过程作为兜底播报。
  有效字词时间戳按实际播放位置揭示摘要，缺失或晚到时整句退化，
  不撤回已显示文字，不等待时间戳阻塞音频。
- 当前网关与配置音色的 CosyVoice 实测返回字词时间戳；
  不推断其他网关/音色也一定支持，Adapter 保留校验和退化。
- 三条同 PCM 合成录音对比：Fun-ASR 松键后最终结果更快，
  Qwen 对 Semi-OS、Pi 等项目用语更准确。样本少且不是真人录音，
  不足以宣布整体优胜。原先保留 Qwen 默认；用户后续反馈真人识别不准确，
  现改用 `fun-asr-realtime` 进行体验验证，Qwen 保留为显式回退。
  此次切换不代表已证明 Fun-ASR 的真人准确率优于 Qwen。
- 采集质量仅记录采样率、RMS、峰值、静音比例和削波数量，不保存原始音频。
  权限、快速按键、真人尾音与插话的原生体验仍需人工验收。
- 证据及未验证项见 `VOICE-OPTIMIZATION-VALIDATION.md`；
  本轮保留 4A 及优化改动，未经 review 批准不提交。

## 2026-10-07：首句延迟与播放链路观测

- 桌面 TTS 默认使用连续 PCM 分片，`mp3` 只作为显式兼容回退。
  这样支持 MediaSource 不可用的 WebView 仍在首个音频分片到达后开始排程，
  不必等完整句子合成结束；PCM 分片不做压缩音频式 cross-fade，避免重复
  样本造成音节重叠。
- 首句准备、TTS 首段音频、实际播放和客户端文字准备分别计时。阶段计时只
  用单调时钟，取消、旧代际和阶段提示不能冒充真实回答首句；客户端的文字
  首次准备也不等于另一个 WebView 已经完成绘制。
- 参考 Lumi 的做法保留“模型首 token → TTS 就绪 → 实际播放”的分段观测，
  以及复用单一 AudioContext 和连续音频排程。Lumi 中面向压缩音频分片的
  50ms cross-fade 不适用于 Semi-OS 的 PCM16 连续样本，因此不复用该策略。
- 单次 Provider 首音频测量仅用于定位链路，不代表用户从松键到首句的端到端
  延迟；整体判断必须同时包含 STT 收尾、Session、模型首句、TTS、WebAudio
  实际播放和客户端绘制。

## 2026-10-08：有声兼容出口与 TTS 连接预热

- 用户确认直接 HTMLAudioElement 出声。当前每句 PCM 完成后封装 WAV，
  不接回 WebAudio；这覆盖上文即时 PCM 排程的默认行为，音量分析暂不可用。
- 本地 LumiCore 的 `server/socket/voice.ts` 在首个完整句子出现时预合成，
  与模型生成重叠并复用结果。Semi-OS 已在首句完整时合成，不重复增加旁路。
- 录音期间可预连接 TTS WebSocket，但不发送 run-task 或文本；首句领取连接，
  闲置最多 15 秒，取消、关闭和连接错误立即释放。不跨合成任务复用连接。
- 追加合成完成耗时，区分首包与整句就绪。预热只缩短握手等待，不宣称消除
  整句合成等待；保持当前 STT、Pi 模型及已确认有声的媒体出口。

## 2026-10-08：长口语摘要的自然停顿切分

- 仅显式 `<speech>` 摘要启用软切分：累计至少 18 个汉字后遇到引号、
  括号外的中文逗号或分号即可进入 TTS；短句、英文及冒号不提前切。
- 包含 URL、代码或结构标记的当前片段放弃软切分，保持原句末规则。
  完整 Markdown 报告、缺标记兜底和阶段提示的边界不变。
- 自然停顿不是语义完整性的证明，首段可能仍依赖后文；不把这一优化
  宣称为“首句完整结论”。既有 `speech.first_sentence_ready` 指标保持
  名称兼容，启用软切分后表示首个可播报分段准备。
- 保持当前有声的 WAV 出口，不恢复曾出现无声的 WebAudio 默认路径；
  软切分减少等待生成及单段合成的文本量，端到端收益须真人复测。

## 2026-10-11：4B 用户主导的多 Agent 工作流

### 后台托管优化（实现及自动验证已完成，原生故障验收待补）

- 前台聊天与每工作流后台 Pi 分离，均使用官方 Runtime Adapter；后台不接
  STT/TTS，无事件不调用模型。Host 保存单协调者领取、检查点和处理游标。
- 真人批准总计划同时授予范围内托管权，代理决策单独留痕；批准状态与
  执行状态分离。扩大需求、权限、push、源分支应用始终需要真人。
- 排队未启动可恢复；已发送启动或结果未知先对账，脏工作区不得丢弃。
- 可安全重试的通信最多三次（2/10/30 秒）；模型或工具结果不明不得重放。
  三次无进展进入需要用户处理。窗口关闭继续运行，显式退出停止并保存。
- 2026-10-11 真实后台冒烟通过：一份预先定义的总计划、一次真人批准，
  真实后台 Pi 自主派发 4 次尝试、整合、测试和独立审查，11 个事件驱动轮次；
  Rust Host/SQLite 保存 verified 证据，源仓库不变。脚本不替 Pi 选择推进步骤。
- Claude `AskUserQuestion` 真实结构化回调通过，不模拟键盘批准；计划退出
  尚未验证，采用计划产出后明确派发实施任务的流程。CLI 子进程禁自动更新。
- Codex 只读 shell 改为 Host 解析实际命令/路径；未知命令不降级。
  Git status 必须关闭 fsmonitor，diff 必须关闭外部 diff/textconv。
  范围内文件写入自动授权，无法证明边界的 shell/批量修改仍须真人。
- macOS 受限测试运行器允许工作区/临时目录写入、去除密钥并禁网，真实
  测试覆盖越界读写及网络拒绝；不把 cwd 或 Provider 名字当作沙箱证明。
- 批准状态与执行状态分开查询。客户端通知及托盘提示去重，不是系统通知
  中心弹窗；后台不播报。自然语言目标变更依赖控制工具，UI 修改入口先撤销授权。
- 原生窗口关闭、显式退出、聊天并行、崩溃/断网恢复及真实自主返工仍需
  专项体验验收，不以合成仓库与自动测试宣布上述原生场景全部通过。

- 用户批准计划后才能实施；批准由 Rust Host 记录并绑定计划版本、内容摘要
  及用户意图代际，Worker 不得伪造批准。最新用户要求高于 Agent 安排。
- 主 Pi 自主选角色、Provider、颗粒度和执行顺序，不新增 Agent Loop。
  DAG 禁止环，执行尝试与返工追加保存；默认最多两个运行中的子 Agent。
- 提案、批准、执行完成和成果验证是独立事实。新目标递增意图代际并重批；
  范围内换执行者、拆分未交付工作及增加审查使用独立 refinement 入口，
  Host 比较目标/范围/验收/仓库/基线/授权不变后记录批准来源。运行或结果
  不确定时先停止/对账，已交付工作项不可改写以冒充新任务成果。
- Node 管理 Provider、进程和 worktree；Host 管理策略及 SQLite。
  公共进程层支持管道/PTY，Provider 声明真实能力，不用权限跳过模式。
- 写任务使用 `codex/` 隔离分支；脏源仓库需用户选择。已批准计划须显式授权
  本地成果提交，整合 worktree 串行 cherry-pick，不自动 push/修改当前分支。
  用户应用成果需另行确认源 ref/HEAD 和整合提交，Host 单次授权；
  只允许干净目录 fast-forward，拒绝分叉及基线变化。授权待处理或 unknown
  时阻止新操作，重启后人工核对并废止旧令牌，不盲目重试、不回滚用户改动。
- 完成事件不等同测试/审查通过；证据绑定成果版本，变化后失效。三轮未解决
  的同一问题需用户决策。重启不确定结果先对账，不自动重做。
- Session 切换及语音停止不取消后台协作。客户端沿用右卡片和全高抽屉；
  先持久化再展示，提供真实批准/拒绝/修改、暂停/恢复/取消入口。
- UI 按 Provider 实际能力显示控制；Claude 不支持轮中 steer 时不提供假入口。
  健康检查只生成一次无活动事件并通知主 Pi，不以轮询模型或自动重启解决卡住。
  Provider 失败仅映射脱敏类别，不转发原始 errors/result 或认定所有失败都是认证问题。
- 4A 已推送；4B 按八个交付点逐块实现、记录验收，未经用户 review 批准不提交。

## 2026-10-23：调研等待、审批回传与插话证据

- 同一授权的确认通知与最终决定使用不同、可稳定重试的 RPC requestId；
  operationId 继续关联原始授权，不改变 Pi 原生工具的等待与继续机制。
- 浏览器启动和单动作分别有界；动作预算覆盖导航、条件等待与页面读取。
  超时关闭受控页面，采集失败保留来源原因，不在后台继续操作。
- 正文与页面身份原子读取，广告或时钟变化仍使动作引用过期，但不否定
  已采集的正文。简单查询先满足问题，不将 3–5 个来源作为硬性数量门槛。
- 插话后的报告可引用 Host 已记录的同一会话较早轮次证据；不得跨会话、
  引用未来轮次或伪造片段。来源及 Artifact 保留原任务身份。
- 用户明确要求立即汇报时，Pi 应优先使用已有证据并说明限制；不新增
  分类模型、关键词路由或第二套 Agent Loop。上述行为需回归与原生验收。

## 2026-10-24：4C 原生桌面与 Lark 验收边界

- Semi-OS 是目标仓库，LumiCore 只作为设计参考。原生桌面控制仍由 Rust
  Host 独占，Node 只负责注册工具和适配 Pi。
- 4C 的动作契约固定为“新鲜观察、一个原子动作、Host 验证”；租约、观察
  引用和人工接管代次不一致时停止新动作。动作已进入系统但没有可核验读回
  必须标记 `unknown`，不能自动重试。
- 自动 Fixture、Rust Storage 恢复测试和真实 macOS/Lark 人工验收分开记录；
  不以权限状态、截图变化或工具注册证明业务完成。
- Lark 发送使用稳定幂等键。`chatId` 目标超时可以查询准确会话历史；`userId`
  目标没有稳定的按用户查询能力时直接返回 `unknown_send`，不使用空会话 ID
  进行伪对账。
- 视觉回退当前明确为不可用，直到真实图片调用、窗口/观察版本绑定和敏感
  界面拒绝均有证据；不因 Screen Recording 已授权而提前开放。

## 2026-10-25：协议校验不得依赖运行期代码生成

- 桌面版 CSP 固定为 `script-src 'self'`，WebView 不允许 `eval`/`new Function`。
  协议校验器因此在生成阶段用 Ajv standalone 编译成普通函数模块，运行期只
  分发调用；`ajv.compile()` 只允许出现在生成器里。
- 该缺陷不会被 `pnpm dev` 发现（Vite dev server 不发 CSP），只在打包后的
  客户端出现，表现为模块初始化抛 `EvalError`、界面白屏。回归门禁是
  `packages/protocol` 的测试在 `--disallow-code-generation-from-strings` 下
  运行。
- 载荷可空性有两种等价写法：`type: ["object","null"]` 与
  `oneOf: [{type:"null"}, ...]`。Rust message registry 必须同时识别，否则
  合法的 `null` 响应会被判为非法载荷并触发 Worker 重启循环。

## 2026-10-25：Worker 启动不依赖 GUI 环境变量

- 由 launchd 启动的 `.app` 只继承 `/usr/bin:/bin:/usr/sbin:/sbin`，Node 通常
  不在其中。Host 因此按 `SEMI_OS_NODE` → Homebrew 固定前缀 → nvm 版本目录
  （从高到低）→ 登录 shell `command -v node` → PATH 扫描的顺序解析出绝对
  路径，解析结果不依赖终端环境，且顺序确定可测。
- 解析失败不得中断客户端启动，也不得静默降级：原因写入状态并由
  `get_worker_status` 暴露到界面，`RestartLimitReached` 同样显式通知。
  「界面能用、但什么也不工作」比一条错误信息更难排查。
- 该差异不会被 `tauri dev` 发现：终端继承了完整 PATH，只有 `open`/Dock
  启动的 bundle 才缺少 Node；与 CSP 白屏属于同一类「仅打包后暴露」缺陷。

## 2026-10-25：hardened runtime 下的麦克风 entitlement

- Tauri 默认给可执行文件开启 hardened runtime。该模式下 TCC 只在签名携带
  `com.apple.security.device.audio-input` 时允许弹出麦克风授权；缺失时连弹窗
  都不会出现，应用也不会被列入「系统设置 → 隐私与安全性 → 麦克风」。因此
  `apps/desktop/src-tauri/entitlements.plist` 只声明这一项权限，不因方便而
  开启 App Sandbox 或其他能力。
- 麦克风是唯一需要同时满足「Info.plist 描述」与「签名 entitlement」的权限；
  它也因此必须可从设置页主动请求：TCC 只把发起过请求的进程列为可授权项。
- 曾使用 ad-hoc 签名，授权可能因重建后的代码要求变化而失效。当前已改用
  `Semi-OS Local Signing` 固定证书；2026-10-26 的真实 bundle 指定要求包含
  稳定的 identifier 与 certificate root，不能继续把当前故障归为 ad-hoc。

## 2026-10-26：原生辅助功能观察与监听恢复

- 历史桌面回执存在“权限检查通过、随后窗口观察失败”，原通用错误隐藏了
  真正失败阶段。改为闭集错误分别表示权限拒绝、无应用/窗口、AX 通信失败、
  接口不可用和前台变化；不泄露窗口正文。
- 优先使用 NSWorkspace 前台 PID 创建应用级 AX 根，保留 SystemWide 全局
  通信超时，单独设置应用根超时。焦点窗口无值时只读取同应用主窗口，
  观察结束再次核对前台 PID，不选择其他应用或任意列表首项。
- 输入事件 tap 失效后保持动作停用；用户明确重新检查、完成授权或恢复时，
  Host 废弃旧租约与引用再重建。页面挂载/焦点刷新仅查状态，不能隐式恢复；
  重新检查权限也不解除用户暂停。
- 打包 App 新增 `--desktop-diagnostic` 只读入口和客户端“只读自检”，不启动
  模型或动作，不输出窗口内容。验收应使用 `open`/LaunchServices 启动 bundle：
  本次该路径四项权限均 granted、监听可用且观察到 11 个控件，而直接从 shell
  启动包内 executable 的权限结果不同，不能混用进程身份的证据。
- 当前 Worker 仍从编译期仓库路径和本地 Node 启动；这属于未完成的独立发行
  打包工作，不将本机 bundle 构建或只读观察通过等同于可移植发布通过。

## 2026-10-30：阶段 5 计划锁定

2026-10-30 群聊中，锦阳确认两份计划都可以执行（「2个计划都没问题 直接开干」）：
Semi-OS 产品老板的阶段 5 产品计划，以及 Semi-OS 工程督导的 4-PR 实施计划。
本条锁定范围和验收口径。通过表、组装顺序、四个有序 PR 和完成定义写在
`docs/5-VALIDATION.md`。`tasks.md` 的勾选不由本条改写。

- 阶段 5 交付 P5.1–P5.9 全量。依赖 P2.1–P2.7 与 P2.13–P2.15，可与阶段 4 并行。
- 4C 真人验收仍是未偿债务，不算过。自动门禁变绿或「代码已交」都不能把 4C
  标成完成；并行启动阶段 5 也不抵销这笔债务。过线口径仍是
  `docs/4C-VALIDATION.md` 的最小演示过线。
- 视觉回退、PV.6、Worker 发行打包继续留在阶段 5 之外。
- 非目标不变：Dream Cycle、图记忆、复杂衰减、自动 Skill 晋升。压缩摘要留在
  L0，不是长期记忆；人格推断不是用户事实。
- 组装顺序固定为 Host policy → 紧凑人格 → L1 → L0 → 按需的 L2–L5，与
  `docs/DESIGN.md` 第 9.2 节相同，实现不得改序。
- 实现分成四个 PR，前一个合并后才做下一个：P5.1+P5.2，P5.3+P5.4+P5.5，
  P5.6+P5.7，P5.8+P5.9。每个 PR 以 `pnpm check` 通过为门禁，不主动合并。
- 阶段 5 完成等于上述自动门禁证据，加上 P5.8 与抽查演示。本条不宣称这些
  证据已经存在。

## Explicitly deferred

- Wake-word and automatic end-of-speech detection.
- Windows and Linux native automation.
- Third-party plugin/skill marketplace.
- MCP server ecosystem.
- Remote execution and multi-device control.
- Full visual-computer-use as the primary locator.
- Dream cycles, graph memory, complex decay and automatic Skill promotion.
- Exact memory token budgets, compaction thresholds and embedding implementation.
- WeChat-specific adapter and message workflow.

## Architecture invariants

1. Model text never proves that a task succeeded.
2. Every side effect is represented by an auditable tool receipt.
3. An approval is bound to the exact target, action and payload digest.
4. An uncertain external outcome is never retried blindly.
5. Rust is the authority for privileged OS actions and durable local state.
6. The Pi integration is replaceable through `AgentRuntimeAdapter`.
7. The UI consumes domain events; it does not parse model prose into task state.
8. Memory writes are automatic for normal low-risk content, but deterministic
   secret/privacy/identity filters still apply.
9. Compaction preserves active-task continuity; it does not silently promote
   summaries into durable memory.
10. Personality, user facts, task history and execution evidence remain separate
    data and prompt layers.
