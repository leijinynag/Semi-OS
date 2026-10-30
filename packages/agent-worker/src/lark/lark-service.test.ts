import assert from "node:assert/strict";
import test from "node:test";
import type { LarkCommandResult, LarkCommandRunner } from "./lark-service.ts";
import { LarkCommandError, LarkService } from "./lark-service.ts";
import { createLarkTools } from "./lark-tools.ts";

class FakeRunner implements LarkCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  readonly #handler: (args: readonly string[], call: number) => LarkCommandResult | Error;

  constructor(handler: (args: readonly string[], call: number) => LarkCommandResult | Error) {
    this.#handler = handler;
  }

  async run(
    executable: string,
    args: readonly string[],
    _options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
  ): Promise<LarkCommandResult> {
    this.calls.push({ executable, args });
    const result = this.#handler(args, this.calls.length);
    if (result instanceof Error) throw result;
    return result;
  }
}

function ok(value: unknown): LarkCommandResult {
  return { stdout: JSON.stringify(value), exitCode: 0 };
}

test("uses only bounded structured commands and sanitizes credential-shaped fields", async () => {
  const runner = new FakeRunner((args) => {
    assert.deepEqual(args.slice(0, 3), ["docs", "+search", "--query"]);
    assert.ok(!args.includes("--dry-run"));
    return ok({
      items: [{ title: "Roadmap", url: "https://example.test/doc", access_token: "secret" }],
      page_token: "next",
    });
  });
  const service = new LarkService({
    executable: "/bin/lark-cli",
    runner,
  });

  const result = await service.searchDocs("roadmap", new AbortController().signal);
  assert.equal(result.items[0]?.access_token, "[redacted]");
  assert.equal(result.nextPageToken, "next");
  assert.equal(runner.calls[0]?.executable, "/bin/lark-cli");
});

test("uses a stable bounded idempotency key for sends", async () => {
  const runner = new FakeRunner((args) => {
    assert.deepEqual(args.slice(0, 5), ["im", "+messages-send", "--chat-id", "oc_test", "--text"]);
    const keyIndex = args.indexOf("--idempotency-key");
    assert.ok(keyIndex >= 0);
    assert.match(String(args[keyIndex + 1]), /^so_[a-f0-9]{40}$/);
    return ok({ message_id: "om_test" });
  });
  const service = new LarkService({ executable: "/bin/lark-cli", runner });
  const signal = new AbortController().signal;
  const first = await service.sendMessage(
    { chatId: "oc_test", text: "hello", idempotencyKey: "task:attempt" },
    signal,
  );
  const second = await service.sendMessage(
    { chatId: "oc_test", text: "hello", idempotencyKey: "task:attempt" },
    signal,
  );
  assert.equal(first.message_id, "om_test");
  assert.equal(second.message_id, "om_test");
  assert.equal(
    runner.calls[0]?.args[runner.calls[0].args.indexOf("--idempotency-key") + 1],
    runner.calls[1]?.args[runner.calls[1].args.indexOf("--idempotency-key") + 1],
  );
});

test("reconciles a send timeout from the exact chat history before returning unknown", async () => {
  const runner = new FakeRunner((args, call) => {
    if (call === 1) return new LarkCommandError("timeout", "timed out");
    assert.deepEqual(args.slice(0, 3), ["im", "+chat-messages-list", "--chat-id"]);
    return ok({ items: [{ message_id: "om_test", body: { content: "hello" } }] });
  });
  const service = new LarkService({
    executable: "/bin/lark-cli",
    runner,
    now: () => 123,
  });
  const result = await service.sendMessage(
    { chatId: "oc_test", text: "hello", idempotencyKey: "task:attempt" },
    new AbortController().signal,
  );
  assert.equal(result.status, "reconciled");
  assert.equal(result.reconciledAtMs, 123);
});

test("does not retry an uncertain send when reconciliation cannot prove it", async () => {
  const runner = new FakeRunner((args, call) => {
    if (call === 1) return new LarkCommandError("timeout", "timed out");
    return ok({ items: [{ message_id: "om_other", body: { content: "different" } }] });
  });
  const service = new LarkService({ executable: "/bin/lark-cli", runner });
  await assert.rejects(
    service.sendMessage(
      { chatId: "oc_test", text: "hello", idempotencyKey: "task:attempt" },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof LarkCommandError && error.code === "unknown_send",
  );
  assert.equal(runner.calls.length, 2);
});

test("does not use an empty chat id to reconcile a user send timeout", async () => {
  const runner = new FakeRunner((args) => {
    assert.deepEqual(args.slice(0, 3), ["im", "+messages-send", "--user-id"]);
    return new LarkCommandError("timeout", "timed out");
  });
  const service = new LarkService({ executable: "/bin/lark-cli", runner });

  await assert.rejects(
    service.sendMessage(
      { userId: "ou_test", text: "hello", idempotencyKey: "task:user" },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof LarkCommandError &&
      error.code === "unknown_send" &&
      error.message.includes("cannot be reconciled"),
  );
  assert.equal(runner.calls.length, 1);
});

test("reports an unavailable CLI without attempting a process", async () => {
  const service = new LarkService({
    executable: undefined,
    environment: { PATH: "" },
  });
  assert.equal(service.available, false);
  await assert.rejects(
    service.searchDocs("roadmap", new AbortController().signal),
    (error: unknown) => error instanceof LarkCommandError && error.code === "unavailable",
  );
});

test("preserves authentication failures as command failures", async () => {
  const runner = new FakeRunner((args) => {
    assert.deepEqual(args, ["whoami", "--as", "user", "--format", "json"]);
    return { stdout: "{}", stderr: "not logged in", exitCode: 1 };
  });
  const service = new LarkService({ executable: "/bin/lark-cli", runner });
  await assert.rejects(
    service.whoami("user", new AbortController().signal),
    (error: unknown) => error instanceof LarkCommandError && error.code === "command_failed",
  );
});

test("rejects oversized or ambiguous send parameters before invoking the CLI", async () => {
  const runner = new FakeRunner(() => ok({ message_id: "om_test" }));
  const service = new LarkService({ executable: "/bin/lark-cli", runner });
  const signal = new AbortController().signal;

  await assert.rejects(
    service.sendMessage(
      { chatId: "oc_test", userId: "ou_test", text: "hello", idempotencyKey: "ambiguous" },
      signal,
    ),
    /exactly one of chatId or userId/,
  );
  await assert.rejects(
    service.sendMessage(
      { chatId: "oc_test", text: "x".repeat(20_001), idempotencyKey: "oversized" },
      signal,
    ),
    /invalid text/,
  );
  assert.equal(runner.calls.length, 0);
});

test("exposes read and confirmed send tools with conservative contracts", () => {
  const tools = createLarkTools(new LarkService({ executable: "/bin/lark-cli" }));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "lark_search_docs",
      "lark_read_doc",
      "lark_list_chats",
      "lark_list_messages",
      "lark_send_message",
    ],
  );
  assert.equal(tools.at(-1)?.riskLevel, "external_side_effect");
  assert.equal(tools.at(-1)?.contract?.reconciliation, "required");
});
