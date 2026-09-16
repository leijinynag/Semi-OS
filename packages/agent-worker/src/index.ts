import {
  decodeJsonl,
  encodeJsonl,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  type Envelope,
  type RequestId,
} from "@semi-os/protocol";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const workerName = "semi-os-agent-worker";

/**
 * 处理单条 Host 请求。
 *
 * Worker stdout 是专用 JSONL 协议通道，普通日志只能写 stderr，避免一行
 * 调试输出破坏 Host 的分帧和协议校验。
 */
export function handleWorkerLine(line: string, pid = process.pid): Envelope {
  const request = decodeJsonl(line);
  if (request.direction !== "request" || request.kind !== "health.check") {
    return {
      direction: "error",
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      kind: "request.error",
      payload: {
        code: "unsupported_request",
        message: `Unsupported worker request: ${request.kind}`,
        retryable: false,
      },
    };
  }

  return {
    direction: "response",
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: "health.ready",
    payload: {
      worker: workerName,
      pid,
    },
  };
}

function protocolError(error: unknown): Envelope {
  const message =
    error instanceof ProtocolValidationError
      ? error.message
      : "Worker failed to parse request";
  return {
    direction: "error",
    protocolVersion: PROTOCOL_VERSION,
    requestId: "req_worker_protocol_error" as RequestId,
    kind: "protocol.error",
    payload: {
      code:
        error instanceof ProtocolValidationError
          ? error.code
          : "invalid_request",
      message,
      retryable: false,
    },
  };
}

export function runWorker(): void {
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  lines.on("line", (line) => {
    try {
      process.stdout.write(encodeJsonl(handleWorkerLine(line)));
    } catch (error) {
      process.stderr.write(`[agent-worker] ${String(error)}\n`);
      process.stdout.write(encodeJsonl(protocolError(error)));
    }
  });
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  runWorker();
}
