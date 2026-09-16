import { createInterface } from "node:readline";

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

// 先完成合法健康握手，再确定性崩溃，用于验证 Host 的退出诊断和有限重启。
lines.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      direction: "response",
      protocolVersion: 1,
      requestId: request.requestId,
      kind: "health.ready",
      payload: {
        worker: "crashing-worker-fixture",
        pid: process.pid,
      },
    })}\n`,
  );
  setTimeout(() => process.exit(23), 20);
});
