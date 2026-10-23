# React Bits 输入控件

`SlingButton.jsx/.css`、`VoicePill.jsx/.css` 来自用户提供的 React Bits
JavaScript + CSS 源码，依赖为 `motion`、`@hugeicons/react` 和
`@hugeicons/core-free-icons`。保留原始视觉与动画，不是重新实现的替代品。
`.d.ts` 为业务调用提供 TypeScript 类型，不改变原组件的实现方式。

VoicePill 的必要适配：

- `active` 同步助手真实录音门控，不重复触发业务回调。
- `reactive="external"` 不申请第二路麦克风；当前关闭模拟波形。
- 指针取消与失去 capture 丢弃录音，不能当成发送。
- 仅取消自己开启的录音，不在组件卸载时取消快捷键录音。
- 取消文案中文化。

客户端通过 Host 转交意图，唯一采集器仍在助手 WebView。
此处 Hugeicons 是原组件专用依赖，不改变应用其余部分的 Phosphor 图标规则。
