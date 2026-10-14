import fs from "node:fs";
import readline from "node:readline";

// 在 ACK 前留下可核对的副作用，再崩溃；重启实例保持存活以检测错误重放。
const [recordPath, mode] = process.argv.slice(2);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.kind !== "health.check") {
    fs.appendFileSync(recordPath, `${request.requestId}\n`);
    if (mode === "crash") {
      process.exit(23);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      direction: "response",
      protocolVersion: 1,
      requestId: request.requestId,
      kind: request.kind === "health.check" ? "health.ready" : "workflow.control.accepted",
      payload: request.kind === "health.check" ? { pid: process.pid } : { accepted: true },
    })}\n`,
  );
});
