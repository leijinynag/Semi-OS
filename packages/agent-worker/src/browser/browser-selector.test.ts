import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticBrowserBackend, selectBrowserBackend } from "./browser-selector.ts";
import type { BrowserBackend } from "./browser-backend.ts";

const exists =
  (paths: readonly string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path);

test("prefers Ego Lite when the app and CLI are installed", async () => {
  const selection = await selectBrowserBackend({
    platform: "darwin",
    env: { HOME: "/home/test", PATH: "/bin" },
    pathExists: exists(["/Applications/ego lite.app"]),
    commandExists: async (path) => path === "ego-browser",
  });

  assert.equal(selection.backend, "ego");
  assert.equal(selection.executable, "ego-browser");
  assert.equal(selection.appPath, "/Applications/ego lite.app");
});

test("falls back to Playwright only when Ego Lite is not installed", async () => {
  const selection = await selectBrowserBackend({
    platform: "darwin",
    env: { HOME: "/home/test", PATH: "/bin" },
    pathExists: async () => false,
    commandExists: async () => false,
  });

  assert.deepEqual(selection, { backend: "playwright" });
});

test("does not silently fall back when Ego Lite is installed without its CLI", async () => {
  await assert.rejects(
    selectBrowserBackend({
      platform: "darwin",
      env: { HOME: "/home/test", PATH: "/bin" },
      pathExists: exists(["/Applications/ego lite.app"]),
      commandExists: async () => false,
    }),
    /不会回退到 Playwright/,
  );
});

test("shares backend initialization and disposes it once", async () => {
  const { backend, counts } = fixtureBackend();
  const browser = new AutomaticBrowserBackend({ browser: backend });
  const signal = new AbortController().signal;
  await Promise.all([browser.observe("page", signal), browser.observe("page", signal)]);
  assert.equal(counts.observations, 2);
  await Promise.all([browser.dispose(), browser.dispose()]);
  assert.equal(counts.disposals, 1);
  await assert.rejects(browser.observe("page", signal), /已释放/);
});

test("disposal blocks pending operations and releases the late backend exactly once", async () => {
  const { backend, counts } = fixtureBackend();
  const browser = new AutomaticBrowserBackend({ browser: backend });
  const pending = browser.observe("page", new AbortController().signal);
  const rejected = assert.rejects(pending, /已释放/);
  await browser.dispose();
  await rejected;
  assert.equal(counts.observations, 0);
  assert.equal(counts.disposals, 1);
});

function fixtureBackend(): {
  backend: BrowserBackend;
  counts: { observations: number; disposals: number };
} {
  const counts = { observations: 0, disposals: 0 };
  const unused = async (): Promise<never> => {
    throw new Error("unexpected fixture operation");
  };
  return {
    counts,
    backend: {
      open: unused,
      risk: unused,
      policyEvidence: unused,
      act: unused,
      extract: unused,
      observe: async () => {
        counts.observations++;
        return {
          pageId: "page",
          originalUrl: "https://example.test",
          url: "https://example.test",
          title: "Fixture",
          version: 1,
          status: "ready",
          elements: [],
        };
      },
      dispose: async () => {
        counts.disposals++;
      },
    },
  };
}
