import test from "node:test";
import assert from "node:assert/strict";
import { JsonLines, PipeProcess } from "./process.ts";

test("LF framing preserves Unicode separators and split UTF8; oversized frame fails", () => {
  const lines: string[] = [];
  const reader = new JsonLines((line) => lines.push(line));
  const bytes = Buffer.from('{"text":"中文\u2028正文"}\n{"done":true}\n');
  for (const byte of bytes) reader.push(Uint8Array.of(byte));
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).text, "中文\u2028正文");
  assert.throws(() => new JsonLines(() => {}, 2).push(Buffer.from("123")));
});
test("pipe process streams structured output and cancellation settles close", async () => {
  let receive!: (line: string) => void;
  const line = new Promise<string>((resolve) => {
    receive = resolve;
  });
  let exited = false;
  const child = new PipeProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('{\"ready\":true}\\n');setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    onLine: receive,
    onError: () => {},
    onExit: () => {
      exited = true;
    },
  });
  assert.deepEqual(JSON.parse(await line), { ready: true });
  await child.stop();
  assert.equal(exited, true);
  assert.throws(() => child.write({}));
});
