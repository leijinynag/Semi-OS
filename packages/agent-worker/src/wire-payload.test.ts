import assert from "node:assert/strict";
import test from "node:test";
import { toWirePayload } from "./wire-payload.ts";

test("wire payload omits only absent object properties without mutating domain events", () => {
  const evidence = { reference: "page:1", digest: undefined };
  const receipt = { approval: undefined, evidence: [evidence], repeated: evidence, value: null };
  assert.deepEqual(toWirePayload(receipt), {
    evidence: [{ reference: "page:1" }],
    repeated: { reference: "page:1" },
    value: null,
  });
  assert.ok(Object.hasOwn(receipt, "approval"));
  assert.ok(Object.hasOwn(evidence, "digest"));
});

test("wire payload still rejects non-JSON values, array holes and cycles", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    cyclic,
    [undefined],
    Array(1),
    { nested: { value: NaN } },
  ]) {
    assert.throws(() => toWirePayload(invalid), /Invalid domain event JSON value/);
  }
});

test("wire payload preserves explicit approval and failed receipt evidence", () => {
  const payload = {
    status: "unknown",
    approval: { approvalId: "approval_fixture", payloadDigest: "sha256:fixture", approvedAtMs: 1 },
    verification: {
      status: "inconclusive",
      evidence: [{ reference: "page:1", digest: undefined }],
    },
  };
  assert.deepEqual(toWirePayload(payload), {
    ...payload,
    verification: { status: "inconclusive", evidence: [{ reference: "page:1" }] },
  });
});
