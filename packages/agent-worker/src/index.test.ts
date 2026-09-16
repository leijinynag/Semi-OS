import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeJsonl,
  encodeJsonl,
  type RequestId,
  type RequestEnvelope,
} from "@semi-os/protocol";
import { handleWorkerLine, workerName } from "./index.ts";

test("answers a valid health check with health.ready", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_worker_test" as RequestId,
    kind: "health.check",
    payload: null,
  };

  const response = decodeJsonl(
    encodeJsonl(handleWorkerLine(encodeJsonl(request), 42)),
  );
  assert.equal(response.direction, "response");
  assert.equal(response.kind, "health.ready");
  assert.equal(response.requestId, request.requestId);
  assert.deepEqual(response.payload, {
    worker: workerName,
    pid: 42,
  });
});

test("rejects unsupported requests without crashing the worker", () => {
  const request: RequestEnvelope = {
    direction: "request",
    protocolVersion: 1,
    requestId: "req_worker_unknown" as RequestId,
    kind: "unknown.request",
    payload: null,
  };

  const response = handleWorkerLine(encodeJsonl(request), 42);
  assert.equal(response.direction, "error");
  assert.equal(response.kind, "request.error");
  assert.equal(response.payload.code, "unsupported_request");
});
