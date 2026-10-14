import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTest } from "./test-runner.ts";

test("test runner preserves exit code and redacts credentials in evidence", async () => {
  const result = await runTest(
    tmpdir(),
    "printf 'token=secret\\n'; exit 7",
    new AbortController().signal,
  );
  assert.equal(result.exitCode, 7);
  assert.match(result.text, /token=\[redacted\]/);
});

test("test runner cancels an in-flight process and refuses pre-aborted input", async () => {
  const abort = new AbortController();
  const result = runTest(tmpdir(), "sleep 30", abort.signal);
  abort.abort();
  await assert.rejects(result, /取消/);
  await assert.rejects(async () => runTest(tmpdir(), "exit 0", abort.signal));
});

test(
  "macOS confined tests allow workspace builds but reject outside writes, secrets and network",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "semi-test-boundary-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const secret = join(directory, "secret");
    await writeFile(secret, "private-fixture");
    const signal = new AbortController().signal;
    try {
      const good = await runTest(
        workspace,
        `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("built", "ok")'`,
        signal,
        true,
      );
      assert.equal(good.exitCode, 0, good.text);
      assert.equal(await readFile(join(workspace, "built"), "utf8"), "ok");
      const write = await runTest(
        workspace,
        `printf bad > ${JSON.stringify(join(directory, "escape"))}`,
        signal,
        true,
      );
      assert.notEqual(write.exitCode, 0);
      const read = await runTest(workspace, `cat ${JSON.stringify(secret)}`, signal, true);
      assert.notEqual(read.exitCode, 0);
      assert.doesNotMatch(read.text, /private-fixture/);
      const network = await runTest(
        workspace,
        `${JSON.stringify(process.execPath)} -e 'const s=require("net").connect(9,"127.0.0.1");s.on("error",e=>{console.log(e.code);process.exit(1)})'`,
        signal,
        true,
      );
      assert.notEqual(network.exitCode, 0);
      assert.match(network.text, /EPERM|EACCES/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
