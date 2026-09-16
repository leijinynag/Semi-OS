import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      direction: "response",
      protocolVersion: 1,
      requestId: request.requestId,
      kind: "health.ready",
      payload: { pid: process.pid },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      direction: "event",
      protocolVersion: 1,
      requestId: "req_worker_progress",
      kind: "worker.progress",
      payload: { sequence: 1 },
    })}\n`,
  );
});

setInterval(() => {}, 1_000);
