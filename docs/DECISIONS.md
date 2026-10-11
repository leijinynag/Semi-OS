# Semi-OS Decision Log

This file records confirmed product decisions separately from proposals.

## Confirmed

| Area | Decision |
| --- | --- |
| Product | Voice-controlled computer assistant, not a chat client with voice added |
| MVP scenarios | Multi-site research and voice briefing; coding-agent delegation; generic application/Lark CLI operations |
| Desktop shell | Tauri + React + TypeScript |
| Native host | Rust owns windows, permissions, shortcuts, OS automation, secrets and SQLite |
| Agent process | A supervised Node.js worker embeds Pi through an adapter |
| Agent loop | All meaningful tasks pass through Pi; no separate “simple-task agent” |
| Runtime extension | Prefer Pi SDK/extensions; MCP is a later interoperability layer |
| Tools | Dynamically expose only tools currently allowed and available |
| Browser | Playwright first, with a dedicated persistent profile |
| Native automation | macOS first; semantic accessibility lookup, screenshot/vision fallback |
| Action granularity | Fresh observation, one atomic action, structured verification |
| Voice trigger | Push-to-talk in MVP; reserve an automatic wake/VAD branch |
| Voice response | No universal acknowledgement; meaningful stage prompts and the first complete answer sentence are spoken |
| Speech providers | Cloud-first behind STT/TTS provider interfaces; local providers can replace them |
| Interruption | Pause/abort current work and inject steering into the continued Pi session |
| Floating UI | Visible only while hotkey is held, task is running, or confirmation is required |
| Confirmation UI | Voice announcement plus real client confirmation controls; Host retains approval authority |
| Risk policy | `read` and `local_write` auto-run by default; `external_side_effect` confirms |
| Policy settings | Low/high risk defaults are configurable, but high-risk tools default to confirmation |
| Network failure | Limited retry before side effects; uncertain side effects become `unknown` |
| Skills | Candidate matching plus final Agent judgment; built-in only in MVP |
| Skill contents | Skills may include scripts and multi-step workflows |
| Plugins | Extension entry is reserved; MVP loads built-in trusted plugins only |
| Memory | MVP uses a separate six-layer memory subsystem; normal low-risk memories are written automatically without user confirmation |
| Memory compaction | MVP uses simple threshold-based Pi session compaction; compaction summary is working context, not long-term memory |
| Progressive memory loading | Load a compact base pack first, then retrieve deeper memory and evidence on demand |
| Agent personality | Personality is a versioned runtime context layer for identity, tone, behavior and voice; it is separate from user facts and memory evidence |
| Permissions | First-run macOS permission center; missing permission degrades capabilities |
| Client UI | Conversation, tasks, memory, skills and settings; simplified user-facing timeline |
| Task complexity | Do not pre-classify turns with a separate complexity classifier; execution-tool use creates or continues a visible TaskRun, while memory recall alone does not |
| User interruption | Let the Agent decide whether an interruption steers, pauses/cancels or starts a new task; preserve the same session and task evidence |
| Research workflow | MVP supports multi-site collection, synthesis, source recording and voice briefing |
| Application workflow | MVP supports generic app launch/focus and bounded desktop operations; Lark CLI is supported where an operation has a stable command path |
| WeChat | Defer WeChat-specific automation; it is not an MVP acceptance blocker |
| MVP implementation strategy | Research, Coding Agent delegation and generic application operation may be implemented in parallel; they share the same voice, Pi, TaskRun, tool and evidence foundations |
| Coding Agent transport | Use a common PTY-like local terminal adapter first; provider-specific differences are isolated to launch, output parsing, steering, resume and result collection |
| Initial providers | STT, TTS and LLM use cloud providers in the first release, behind replaceable provider interfaces |
| Progress UI | Show a simple event-driven task timeline with current step, recent action, waiting reason and result |
| Assistant visuals | Use expressive mouse-following, particle and speech-wave effects; animation is presentation-only and does not define task semantics |
| Personality and preferences | User may manually edit personality and user preferences; the Agent may append or revise only Agent-created memories and cannot mutate user-authored entries |
| Overlay rendering | Transparent, shadowless, nonfocusing and mouse-passthrough native window; only 3D halo and particles, no visible text |
| Speech synchronization | Prefer validated word timestamps and actual playback position; fallback reveals a sentence on actual playback start |
| Answer format | Required speech with optional Markdown details; simple replies have no duplicate report |
| Streaming recognition | Persistent local microphone gate; only final transcription enters Pi; current Fun default retained pending human comparison |
| Text input | Client chat bypasses only capture/STT; uses the same Pi session, tools, confirmations, TTS, playback synchronization and history |

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
