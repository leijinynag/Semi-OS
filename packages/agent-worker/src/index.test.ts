import assert from "node:assert/strict";
import test from "node:test";
import { decodeJsonl, encodeJsonl, type RequestId, type RequestEnvelope } from "@semi-os/protocol";
import { handleWorkerLine, workerName } from "./index.ts";

test("answers a valid health check with health.ready", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_worker_test" as RequestId,
    kind: "health.check",
    payload: null,
  };

  const response = decodeJsonl(encodeJsonl(handleWorkerLine(encodeJsonl(request), 42)));
  assert.equal(response.direction, "response");
  assert.equal(response.kind, "health.ready");
  assert.equal(response.requestId, request.requestId);
  assert.deepEqual(response.payload, {
    worker: workerName,
    pid: 42,
  });
});

test("rejects unsupported requests without crashing the worker", () => {
  // 未登记 kind 是边界错误，不能通过 encodeJsonl 构造；这里模拟外部
  // 直接送入 Worker 的原始 JSONL，验证 Worker 能返回协议错误而不崩溃。
  const request = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_worker_unknown",
    kind: "unknown.request",
    payload: null,
  };

  const response = handleWorkerLine(`${JSON.stringify(request)}\n`, 42);
  assert.equal(response.direction, "error");
  assert.equal(response.kind, "protocol.error");
  assert.equal(response.payload.code, "unsupported_kind");
});
