# 4A 资料调研工作流：实现与验收

原验收日期：2026-10-06。2026-10-11 用户批准提交，重新运行
`pnpm run check`、`pnpm run format` 与 `git diff --check` 均通过。
本次提交包含共享入口与协议的后续语音、文字对话及 Session 优化；
提交 hash 记录在 `tasks.md`。以下云端测量为原验收记录，本次未重新计费测试。

## 实现边界

```text
React 麦克风 / 来源 / 报告 / 确认
             ↕ Tauri
Rust Host：TaskRun、策略校验、SQLite、Artifact
             ↕ JSONL RPC
Node Worker：语音编排 → Pi 官方 Session / ResourceLoader
                            ↓ Tool Registry / Adapter
                      BrowserService → 专属 Chromium Profile
```

- Pi 是唯一调研 Agent Loop，浏览器服务只调度已请求的动作。
- 四工具使用语义引用和观察版本，不暴露任意脚本；同页串行、最多两个执行槽。
- 导航等 `domcontentloaded`，正文按条件等待，正文分段返回；缓存限定当前观察版本。
- Worker 不开 SQLite。正文、失败来源、引用、报告、进度和回执由 Host 持久化。
- Host 检查正文 SHA256、引用偏移和内容、同任务来源身份。采集和引用验证不代表事实已被独立核验。
- 已识别的普通浏览和资料搜索自动执行；其他点击/输入保守确认，确认绑定输入与观察。
- URL 风险分类是保守启发式，不是任意网站副作用的形式化安全证明。
- 登录限制返回需要用户操作；不绕过验证码。不确定写操作进入 unknown，禁止自动重复。
- `<speech>` 中的简短结论按句合成，详细报告和推理不直接朗读。进度来自结构化事件，不解析模型 prose 推断任务成功。
- 暂停/取消阻止新工具；空闲 Pi Session 的续接走官方 prompt，运行中才用 steer/followUp 入队。

## 自动验证

| 范围 | 证据 |
| --- | --- |
| 浏览器 | 搜索页、多篇正文、重定向、延迟正文、重复目标、过期引用、登录限制、分段缓存 |
| 生命周期 | 同页串行、两个槽并发限制、取消关闭页面、Cookie Profile 重开复用 |
| 风险 | 输入摘要/观察绑定、伪装搜索的危险 action、授权失败/取消的确定拒绝回执 |
| 证据 | Rust Host 实际 SQLite 保存正文/来源/报告；拒绝伪造引用；不能无报告完成或复活取消任务 |
| 语音 | Fake STT/LLM/TTS 完整调研、冲突来源与被阻止来源、分块 speech 标记、旧播放队列停止 |
| 客户端 | 注入测试 Tauri 边界验证真实结构的数据展示、引用打开 Artifact、两条确认依次通过/拒绝 |

客户端测试使用合成 IPC 数据，不冒充真实云端报告。已检查 1440×1000 与
390×844 截图无横向溢出；移动布局不代表完整桌面操作已验收。

## 真实云端验收

命令（会产生云服务费用，不进入默认单测）：

```sh
node --env-file=.env --experimental-strip-types scripts/research-live.ts
```

链路：云 TTS 生成中文请求 → PCM 转换 → 云 STT → 已配置 DeepSeek Pi →
Playwright 读取两个不同官网 → Rust Host 桥接持久化 → 云 TTS 生成结果音频。
没有使用人工麦克风输入，也没有替用户确认真实扬声器播放。

最新输出：`output/research-live-1791287927215/`，全部为 Git 忽略的本地产物。

| 指标 | 本轮测量 |
| --- | --- |
| STT 提交后的工作流总耗时 | 46,128 ms |
| 即时回应首音频合成耗时 | 588 ms |
| Chromium 启动 | 141 ms |
| 导航 | 2,598 / 12,003 / 503 ms，含失败访问及重试 |
| 正文提取 | 20 / 20 ms |
| 模型首次文本事件 | 31,798 ms，含工具执行，不是纯模型推理耗时 |
| 持久化结果 | 2 条带引用结论，档案 4 条来源访问记录、15 条进度 |
| 完成状态 | SQLite task lifecycle = completed，voice.error = 0 |

588 ms 是 TTS 首音频指标，不是按键到实际听见声音的端到端延迟。
报告明确标记“仅首段、未读全文、官方自述未独立核验”，保留首次访问失败。

前一轮同类成功耗时 44,665 ms。更早长文调研曾超出 240 秒并遇到 TTS 错误；
通过限制首段阅读、精简口头结论及抑制中间推理播报完成收敛。
不把成功样本推广成所有网站的固定 SLA，外网耗时不作为单测门槛。

## 检查与复现

```sh
pnpm exec playwright install chromium
pnpm check
cargo fmt --all -- --check
git diff --check
```

完整检查包括 TypeScript、仓库 lint、JavaScript/Rust 测试、Vite 和 Rust build。
Vite 仍有既有大 chunk 警告，构建不因此失败。
浏览器预览没有 Rust Worker，适合界面检查；真实工具操作须运行 Tauri 客户端。

## Review 入口

| 文件 | 重点 |
| --- | --- |
| `packages/agent-worker/src/browser/browser-service.ts` | 浏览器生命周期、观察引用、并发、分段缓存 |
| `packages/agent-worker/src/browser/browser-tools.ts` | 四工具输入级风险与有界执行 |
| `packages/agent-worker/src/pi-runtime.ts` | Pi 原生/自定义工具边界、Skill 注入、回执与取消 |
| `packages/agent-worker/src/research-host.ts` | Host 请求关联、持久化确认与超时 |
| `crates/host/src/research.rs` | 策略校验、引用验证、TaskRun 和报告持久化 |
| `crates/storage/migrations/0002_research.sql` | 来源、正文、报告与确认数据结构 |
| `packages/agent-worker/src/voice/voice-loop.ts` | 即时回应、动作提示、语音结论与文字报告分离 |
| `apps/desktop/src/ui/ResearchWorkbench.tsx` | 真实档案、进度、失败来源、Artifact 和确认队列 |

## 仍需人工体验

- Tauri 客户端真实麦克风录音、扬声器播放、插话后听感。
- 用户在可见专属 Chromium 中登录真实网站，重开验证登录态。
- 真实任务中确认弹窗和网络失败的体验；自动测试已覆盖对应契约。

本阶段不包含长期记忆写入、PDF/OCR、下载上传、新搜索 API 或独立爬虫调研引擎。
