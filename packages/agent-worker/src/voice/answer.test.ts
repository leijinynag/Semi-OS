import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnswer, fallbackSpeech } from "./answer.ts";

test("separates private process, speech, Markdown and research JSON", () => {
  assert.deepEqual(
    normalizeAnswer(
      '内部分析。<speech>简短结论。</speech>## 报告\n- 依据\n```research-report\n{"claims":[]}\n```',
      true,
    ),
    {
      summary: "简短结论。",
      report: "## 报告\n- 依据",
    },
  );
  assert.deepEqual(normalizeAnswer("<think>隐藏内容</think><speech>你好。</speech>", true), {
    summary: "你好。",
    report: "",
  });
  assert.deepEqual(normalizeAnswer("不应公开的工具前过程", true), { summary: "", report: "" });
});

test("fallback speaks one final sentence without code, internal tags or source identifiers", () => {
  assert.equal(
    fallbackSpeech("<think>内部过程。</think>## 结论\n**已经完成。** 后续细节。"),
    "结论 已经完成。",
  );
  assert.equal(fallbackSpeech("```ts\nsecret()\n```"), "");
  assert.equal(fallbackSpeech("完成了[source_123 quote_456]。第二句。"), "完成了。");
  assert.equal(fallbackSpeech("长".repeat(200)), "长".repeat(160));
  assert.equal(fallbackSpeech("已完成"), "已完成");
});

test("keeps an unmarked final answer as text without claiming synchronized speech", () => {
  assert.deepEqual(normalizeAnswer("你好。", false), { summary: "你好。", report: "" });
  assert.deepEqual(
    normalizeAnswer(
      "工具前过程。\n最终回答。",
      true,
      undefined,
      "<think>隐藏内容</think>## 最终回答\n保留可读内容。",
    ),
    {
      summary: "",
      report: "## 最终回答\n保留可读内容。",
    },
  );
});
