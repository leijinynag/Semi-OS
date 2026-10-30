import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("actual Worklet source discards idle input and isolates gate tokens", () => {
  const messages: { kind: string; token: number; samples?: Float32Array }[] = [];
  let Processor!: new () => {
    port: { onmessage(event: { data: { kind: string; token: number } }): void };
    process(inputs: Float32Array[][]): boolean;
  };
  // 执行真实 Worklet 源码而非复写门控逻辑；硬件/浏览器调度仍需原生验收。
  runInNewContext(readFileSync(new URL("./pcm-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class {
      port = {
        postMessage(value: (typeof messages)[number]) {
          messages.push(value);
        },
      };
    },
    registerProcessor(_name: string, value: typeof Processor) {
      Processor = value;
    },
  });
  const processor = new Processor();
  const input = [[new Float32Array(128).fill(0.5)]];
  processor.process(input);
  assert.equal(messages.length, 0);
  processor.port.onmessage({ data: { kind: "begin", token: 1 } });
  processor.process(input);
  processor.port.onmessage({ data: { kind: "end", token: 1 } });
  processor.process(input);
  assert.deepEqual(
    messages.map(({ kind, token }) => [kind, token]),
    [
      ["samples", 1],
      ["flushed", 1],
    ],
  );
  processor.port.onmessage({ data: { kind: "begin", token: 2 } });
  processor.port.onmessage({ data: { kind: "end", token: 1 } });
  processor.process(input);
  assert.equal(messages.at(-1)?.token, 2);
  assert.equal(messages.at(-1)?.kind, "samples");
  assert.equal(messages[0]!.samples?.length, 128);
});
