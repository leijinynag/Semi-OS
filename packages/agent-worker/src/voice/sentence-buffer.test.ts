import assert from "node:assert/strict";
import test from "node:test";
import { SentenceBuffer } from "./sentence-buffer.ts";

const clause = "我已经对比了这几个来源并整理好了主要结论，";

test("explicit Chinese clauses can synthesize before the sentence finishes", () => {
  const buffer = new SentenceBuffer({ chineseClauses: true });
  assert.deepEqual(buffer.push(clause.slice(0, -1)), []);
  assert.deepEqual(buffer.push("，后面继续补充"), [clause]);
  assert.equal(buffer.flush(), "后面继续补充");
  assert.equal(buffer.flush(), undefined);
});

test("default buffering, short fragments and English wait for sentence endings", () => {
  for (const text of ["你好，继续说明", "Hello, this is a fairly long English response; more follows", clause]) {
    const buffer = new SentenceBuffer({ chineseClauses: text !== clause });
    assert.deepEqual(buffer.push(text), []);
    assert.equal(buffer.flush(), text);
  }
});

test("Chinese semicolons split but colons and quoted pauses do not", () => {
  const buffer = new SentenceBuffer({ chineseClauses: true });
  const text = clause.slice(0, -1);
  assert.deepEqual(buffer.push(`${text}：“内容很长，仍是引用”；`), [`${text}：“内容很长，仍是引用”；`]);
  assert.deepEqual(buffer.push(`${text}（还需要，保留括号）`), []);
  assert.equal(buffer.flush(), `${text}（还需要，保留括号）`);
});

test("structured content and URLs cannot qualify for soft splitting", () => {
  for (const marker of ["`code`", "[source_123]", "<speech>", '{"field":1}', "https://example.com/path", "www.example.com"]) {
    const buffer = new SentenceBuffer({ chineseClauses: true });
    assert.deepEqual(buffer.push(`${marker} ${clause}`), []);
  }
});

test("hard boundaries and reset preserve text without duplicated fragments", () => {
  const buffer = new SentenceBuffer({ chineseClauses: true });
  assert.deepEqual(buffer.push(`${clause}这是补充。下个回答`), [clause, "这是补充。"]);
  buffer.clear();
  assert.deepEqual(buffer.push("新的回复。"), ["新的回复。"]);
  assert.equal(buffer.flush(), undefined);
});
