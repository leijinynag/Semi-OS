# 真人录音评测

当前没有真人语料，本文件是准备与执行说明，不是准确率结果。
常驻预热不会保存录音；只使用主动准备的诊断录音。录音/manifest 放在仓库
外，避免提交隐私。每条为单声道 PCM16、16 kHz WAV，两个 Adapter 读取同一
音频。不要用缺失首字的音频判断模型优劣；先人工听音确认首尾完整。

## 清单格式

JSON 数组至少 30 项，路径相对 manifest；覆盖下方六个分类。

```json
[
  {
    "file": "01.wav",
    "reference": "今天上海天气怎么样？",
    "category": "中文",
    "entities": ["上海"]
  }
]
```

显式启动会产生云服务费用。默认输出数值、不输出转写；
`--include-text` 仅用于主动诊断，输出也应保留在仓库外。

```sh
node --env-file=.env --experimental-strip-types scripts/voice-benchmark.ts --manifest /absolute/path/manifest.json
node --experimental-strip-types scripts/voice-latency.ts "$HOME/Library/Application Support/dev.semios.desktop/diagnostics/voice-timing.jsonl"
```

应用标识以 `apps/desktop/src-tauri/tauri.conf.json` 为准；若本机已更改，
调整 Application Support 路径。无 manifest 仍可做三条合成录音冒烟，
但不能当作真人 30 条比较。Fun 词表为 `SEMI_OS_FUN_STT_VOCABULARY_ID`，
必须先创建兼容词表；参数拒绝可见，不隐式降级。当前未验证网关支持。

## 建议 30 条

| 分类       | 参考内容                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| 中文       | 今天上海天气怎么样？                                                                 |
| 中文       | 帮我查一下新能源汽车的最新政策。                                                     |
| 中文       | 比较三个来源，说明不同观点。                                                         |
| 中文       | 请打开浏览器查一下明天的天气。                                                       |
| 中文       | 不要执行操作，先告诉我你的想法。                                                     |
| 英文工具名 | Open Codex and check the test results.                                               |
| 英文工具名 | Please use Claude Code for this task.                                                |
| 英文工具名 | Start Pi in the project folder.                                                      |
| 英文工具名 | Search the Playwright documentation.                                                 |
| 英文工具名 | Check TypeScript and Tailwind CSS.                                                   |
| 中英混合   | 在 Semi-OS 里用 Pi 分析这次修改。                                                    |
| 中英混合   | 用 Codex 写测试，不要直接提交。                                                      |
| 中英混合   | 让 Claude Code 看一下 Rust 的报错。                                                  |
| 中英混合   | 使用 lark-cli 创建飞书文档。                                                         |
| 中英混合   | 用 Playwright 打开网页并提取正文。                                                   |
| 短句       | 暂停。                                                                               |
| 短句       | 继续。                                                                               |
| 短句       | 不要提交。                                                                           |
| 短句       | 打开飞书。                                                                           |
| 短句       | 再查一下。                                                                           |
| 长指令     | 请调研主流助手的长期记忆方案，读取原文，比较存储与召回方式，再用简短语音汇报。       |
| 长指令     | 打开指定项目，调用本地编码助手修复登录问题，观察进度，完成后运行测试，不要提交代码。 |
| 长指令     | 比较三家语音识别服务的准确率、延迟和费用，失败的来源也保留，并说明结论的局限。       |
| 长指令     | 我刚才说的不是替换模型，先修复录音开头缺失的问题，再比较同一批完整录音的结果。       |
| 长指令     | 先停止刚才的任务，打开浏览器阅读官方文档，遇到登录或验证码时告诉我，不要绕过限制。   |
| 数字路径   | 检查端口一四二一是否占用。                                                           |
| 数字路径   | 明天下午三点二十分提醒我。                                                           |
| 数字路径   | 把超时从三十秒改为六十秒。                                                           |
| 数字路径   | 查看 src slash main dot ts 文件。                                                    |
| 数字路径   | 打开 Users slash test slash Semi-OS 路径。                                           |

人工 reference 必须按实际读出的文字标注，不直接复制这张表。
数字“3”与“三”严格 CER 不同，应同时人工判断语义，实体准确率优先关注
工具名/路径。报告加权 CER、实体准确率、失败数、最终延迟 P50/P95，
并记录设备、实际采样率、降噪/AGC、削波和静音情况。不增加 LLM 纠错调用。
