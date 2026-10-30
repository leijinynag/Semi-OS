import assert from "node:assert/strict";
import test from "node:test";
import { createEgoRunner } from "./ego-runner.ts";

test("returns a JSON result when the CLI splits UTF-8 output", async () => {
  const runner = createEgoRunner(process.execPath, {
    timeoutMs: 2000,
    commandArgs: ["--input-type=module"],
  });
  const result = await runner(
    `console.log("中文"); return {message:"中文"};`,
    new AbortController().signal,
  );

  assert.deepEqual(result, { message: "中文" });
});

test("cancels the CLI instead of waiting for a late result", async () => {
  const runner = createEgoRunner(process.execPath, {
    timeoutMs: 2000,
    commandArgs: ["--input-type=module"],
  });
  const controller = new AbortController();
  const pending = runner("await new Promise(() => {});", controller.signal);
  controller.abort();

  await assert.rejects(pending, /已取消/);
});
