import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHandoff, type BrowserSessionState } from "./browser-handoff.ts";
import type { BrowserBackend } from "./browser-backend.ts";
import type { BrowserObservation } from "./browser-service.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { AutomaticBrowserBackend } from "./browser-selector.ts";

const observation: BrowserObservation = {
  pageId: "page_fixture",
  originalUrl: "https://example.test",
  url: "https://example.test/login",
  title: "Login",
  version: 1,
  elements: [],
  status: "needs_user",
  reason: "请登录",
};
const identity = { sessionId: "session_fixture", taskId: "task_fixture" };
const context = () => ({ taskId: identity.taskId, signal: new AbortController().signal });
function fixture(resume?: BrowserBackend["resume"]) {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected action");
  };
  const backend: BrowserBackend = {
    open: async () => observation,
    observe: async () => observation,
    act: unused,
    risk: unused,
    policyEvidence: unused,
    extract: unused,
    dispose: async () => {},
    ...(resume ? { resume } : {}),
  };
  const states: BrowserSessionState[] = [];
  const browser = new AutomaticBrowserBackend({ browser: backend });
  const handoff = new BrowserHandoff(
    browser,
    () => identity,
    (state) => states.push(state),
  );
  return { browser, handoff, states };
}

test("resumes the original tool promise with a fresh observation, without replay", async () => {
  const calls: unknown[] = [];
  const fresh = { ...observation, version: 2, status: "ready" as const };
  const { browser, handoff, states } = fixture(async (mode, _signal, pageId) => {
    calls.push({ mode, pageId });
    return [fresh];
  });
  const saved: unknown[] = [];
  const tool = createBrowserTools(
    browser,
    {
      save: async (source) => {
        saved.push(source);
      },
    },
    handoff.wait(identity.sessionId),
  )[0]!;
  const result = tool.execute(
    { url: "https://example.test" },
    {
      ...context(),
      attemptId: "attempt_fixture",
      attemptNumber: 1,
      idempotencyKey: "fixture",
      startedAtMs: Date.now(),
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(states[0]?.status, "waiting_user");
  const state = handoff.snapshot()!;
  await handoff.resume({ ...state, mode: "takeover" });
  assert.equal((await result).output.version, 2);
  assert.deepEqual(calls, [{ mode: "takeover", pageId: observation.pageId }]);
  assert.deepEqual(
    states.map((state) => state.status),
    ["waiting_user", "resuming", "resumed"],
  );
  assert.throws(() => handoff.resume({ ...state, mode: "takeover" }), /过期/);
});

test("Playwright without resume returns needs_user without suspending forever", async () => {
  const { browser, handoff } = fixture();
  await browser.open("https://example.test", context().signal);
  assert.equal(browser.supportsResume, false);
  assert.equal(await handoff.wait(identity.sessionId)(observation, context()), observation);
  assert.equal(handoff.snapshot(), null);
});

test("rejects stale identities and duplicate requests, cancels takeover without waking another task", async () => {
  let release!: (value: BrowserObservation[]) => void;
  let signal: AbortSignal | undefined;
  const { browser, handoff } = fixture(async (_mode, receivedSignal) => {
    signal = receivedSignal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await browser.open("https://example.test", context().signal);
  const waiting = handoff.wait(identity.sessionId)(observation, context());
  const rejected = assert.rejects(waiting, /停止/);
  const state = handoff.snapshot()!;
  assert.throws(() => handoff.resume({ ...state, taskId: "task_old", mode: "takeover" }), /过期/);
  const operation = handoff.resume({ ...state, mode: "takeover" });
  assert.throws(() => handoff.resume({ ...state, mode: "claim" }), /重复/);
  await new Promise((resolve) => setImmediate(resolve));
  handoff.cancel("任务已停止");
  assert.equal(signal?.aborted, true);
  release([{ ...observation, status: "ready" }]);
  await operation;
  await rejected;
  assert.equal(handoff.snapshot()?.status, "cancelled");
});

test("failed takeover does not automatically claim; explicit retry keeps the same ticket", async () => {
  const modes: string[] = [];
  const { browser, handoff } = fixture(async (mode) => {
    modes.push(mode);
    if (mode === "takeover") throw new Error("user still owns Space");
    return [{ ...observation, status: "ready", version: 3 }];
  });
  await browser.open("https://example.test", context().signal);
  const waiting = handoff.wait(identity.sessionId)(observation, context());
  const state = handoff.snapshot()!;
  await handoff.resume({ ...state, mode: "takeover" });
  assert.equal(handoff.snapshot()?.status, "failed");
  assert.deepEqual(modes, ["takeover"]);
  await handoff.resume({ ...state, mode: "claim" });
  assert.equal((await waiting).version, 3);
  assert.deepEqual(modes, ["takeover", "claim"]);
});

test("still restricted pages remain waiting; abort revokes the resume ticket", async () => {
  const { browser, handoff } = fixture(async () => [observation]);
  await browser.open("https://example.test", context().signal);
  const controller = new AbortController();
  const waiting = handoff.wait(identity.sessionId)(observation, {
    ...context(),
    signal: controller.signal,
  });
  const rejected = assert.rejects(waiting, /停止/);
  const state = handoff.snapshot()!;
  await handoff.resume({ ...state, mode: "takeover" });
  assert.equal(handoff.snapshot()?.status, "waiting_user");
  controller.abort();
  await rejected;
  assert.throws(() => handoff.resume({ ...state, mode: "takeover" }), /过期/);
});
