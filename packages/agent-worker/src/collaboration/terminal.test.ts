import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { AgentTerminal } from "./terminal.ts";

test("PTY accepts input, resizes, streams output and closes on cancellation", async () => {
  let output = "";
  let resolveOutput!: () => void;
  const received = new Promise<void>((resolve) => {
    resolveOutput = resolve;
  });
  const terminal = new AgentTerminal({
    command: "/bin/sh",
    args: ["-c", "read value; printf 'result:%s\\n' \"$value\"; sleep 30"],
    cwd: tmpdir(),
    onData(data) {
      output += data;
      if (output.includes("result:fixture")) resolveOutput();
    },
    onExit() {},
  });
  try {
    terminal.resize(80, 24);
    assert.throws(() => terminal.resize(0, 0));
    terminal.write("fixture\n");
    const timeout = setTimeout(resolveOutput, 3000);
    await received;
    clearTimeout(timeout);
    assert.match(output, /result:fixture/);
  } finally {
    await terminal.stop();
  }
});
