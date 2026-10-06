import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const request = JSON.parse(line);
  const health = request.kind === "health.check";
  process.stdout.write(
    `${JSON.stringify({
      direction: health ? "response" : "event",
      protocolVersion: 1,
      requestId: request.requestId,
      kind: health ? "health.ready" : "fixture.echo",
      payload: health ? { pid: process.pid } : request.payload,
    })}\n`,
  );
});
