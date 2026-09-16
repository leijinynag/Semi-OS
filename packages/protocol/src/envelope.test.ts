import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertValidEnvelope,
  decodeJsonl,
  encodeJsonl,
  ProtocolValidationError,
} from "./envelope.ts";

// Node 与 Rust 测试读取同一份 Fixture，用它锁定跨运行时的字段命名和结构。
const fixturePath = resolve(
  process.cwd(),
  "../../tests/contract/fixtures/request.json",
);

test("accepts the shared request fixture", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  assertValidEnvelope(fixture);
  assert.deepEqual(decodeJsonl(encodeJsonl(fixture)), fixture);
});

test("rejects an unknown protocol version", () => {
  assert.throws(
    () =>
      assertValidEnvelope({
        direction: "request",
        protocolVersion: 99,
        requestId: "req_fixture_001",
        kind: "health.check",
        payload: null,
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError &&
      error.code === "unsupported_version",
  );
});

test("rejects malformed JSONL and invalid identifiers", () => {
  assert.throws(
    () => decodeJsonl('{"direction":"request"}'),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "missing_field",
  );
  assert.throws(
    () =>
      decodeJsonl(
        '{"direction":"request","protocolVersion":1,"requestId":"bad","kind":"x","payload":null}',
      ),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_field",
  );
  assert.throws(
    () => decodeJsonl("{not-json}"),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_json",
  );
});
