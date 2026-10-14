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
const fixturePath = resolve(process.cwd(), "../../tests/contract/fixtures/request.json");

test("accepts the shared request fixture", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  assertValidEnvelope(fixture);
  assert.deepEqual(decodeJsonl(encodeJsonl(fixture)), fixture);
});

test("shares field-level positive and negative contracts with Rust", async () => {
  const cases = JSON.parse(
    await readFile(
      resolve(process.cwd(), "../../tests/contract/fixtures/payload-cases.json"),
      "utf8",
    ),
  ) as Array<{ name: string; valid: boolean; message: unknown }>;
  for (const entry of cases) {
    if (entry.valid) assert.doesNotThrow(() => assertValidEnvelope(entry.message), entry.name);
    else
      assert.throws(() => assertValidEnvelope(entry.message), ProtocolValidationError, entry.name);
  }
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
      error instanceof ProtocolValidationError && error.code === "unsupported_version",
  );
});

test("rejects malformed JSONL and invalid identifiers", () => {
  assert.throws(
    () => decodeJsonl('{"direction":"request"}'),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "missing_field",
  );
  assert.throws(
    () =>
      decodeJsonl(
        '{"direction":"request","protocolVersion":1,"requestId":"bad","kind":"health.check","payload":null}',
      ),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_field",
  );
  assert.throws(
    () => decodeJsonl("{not-json}"),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "invalid_json",
  );
});

test("rejects unknown kinds and malformed registered payloads at the envelope boundary", () => {
  assert.throws(
    () =>
      assertValidEnvelope({
        direction: "request",
        protocolVersion: 1,
        requestId: "req_unknown_kind",
        kind: "unknown.request",
        payload: {},
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "unsupported_kind",
  );
  assert.throws(
    () =>
      assertValidEnvelope({
        direction: "request",
        protocolVersion: 1,
        requestId: "req_bad_payload",
        kind: "voice.text.submit",
        payload: "not-an-object",
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_payload",
  );
  assert.throws(
    () =>
      assertValidEnvelope({
        direction: "response",
        protocolVersion: 1,
        requestId: "req_wrong_direction",
        kind: "health.check",
        payload: {},
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "unsupported_kind",
  );
});

test("validates fields and rejects lossy JSON even in extension properties", () => {
  const request = (payload: unknown) => ({
    direction: "request",
    protocolVersion: 1,
    requestId: "req_fields",
    kind: "health.check",
    payload,
  });
  for (const payload of [
    { includeCapabilities: "yes" },
    { extension: NaN },
    { extension: Infinity },
    { extension: undefined },
    { extension: new Date() },
    { extension: 1n },
  ])
    assert.throws(() => assertValidEnvelope(request(payload)), ProtocolValidationError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertValidEnvelope(request(cyclic)), ProtocolValidationError);
  assertValidEnvelope(request({ extension: { a: [1, true, null] } }));
});
