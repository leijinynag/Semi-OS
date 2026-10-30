import assert from "node:assert/strict";
import test from "node:test";
import { EgoBrowserService } from "./ego-browser-service.ts";
import { BrowserNeedsUser } from "./browser-backend.ts";

function fixture() {
  const scripts: string[] = [];
  let restricted = true;
  let failAction = false;
  const browser = new EgoBrowserService(async (script) => {
    scripts.push(script);
    if (script.includes("takeOverTaskSpace") || script.includes("claimTaskSpace"))
      return { spaceId: 42 };
    if (script.includes("handOff()")) return null;
    if (script.includes("const receipt") && failAction) throw new Error("uncertain action");
    return {
      spaceId: 42,
      label: "p1",
      data: {
        url: "https://example.test/article",
        title: "Article",
        text: restricted ? "sign in to continue" : "Article",
        content: "Article",
        elements: [
          {
            role: "button",
            name: "Continue",
            value: "",
            labelled: true,
            search: false,
            unsupported: false,
          },
        ],
      },
    };
  });
  return {
    browser,
    scripts,
    allow: () => {
      restricted = false;
    },
    restrict: () => {
      restricted = true;
    },
    failAction: () => {
      failAction = true;
    },
  };
}
const signal = () => new AbortController().signal;

test("takes over the original Space and invalidates refs even when DOM is unchanged", async () => {
  const { browser, scripts, allow } = fixture();
  const first = await browser.open("https://example.test/article", signal());
  assert.equal(first.status, "needs_user");
  assert.ok(scripts.at(-1)?.includes("handOff()"));
  // 未解决限制也必须撤销旧引用，并再次交还。
  const [blocked] = await browser.resume("takeover", signal(), first.pageId);
  assert.equal(blocked?.status, "needs_user");
  assert.ok(blocked!.version > first.version);
  allow();
  const count = scripts.length;
  const [fresh] = await browser.resume("takeover", signal(), first.pageId);
  assert.equal(fresh?.status, "ready");
  assert.ok(fresh!.version > blocked!.version);
  const recovery = scripts.slice(count);
  assert.ok(recovery[0]?.includes("takeOverTaskSpace(42)"));
  assert.ok(recovery.every((script) => !/page\.(goto|click|fill)\(/.test(script)));
  await assert.rejects(
    browser.act(first.pageId, first.version, first.elements[0]!.ref, undefined, signal()),
    /过期|stale/i,
  );
  assert.ok(scripts.every((script) => !script.includes("claimTaskSpace")));
  await browser.dispose();
});

test("restriction discovered during risk checking remains recoverable without an action", async () => {
  const { browser, allow, restrict, scripts } = fixture();
  allow();
  const first = await browser.open("https://example.test/article", signal());
  restrict();
  await assert.rejects(
    browser.risk(first.pageId, first.version, first.elements[0]!.ref, false, signal()),
    BrowserNeedsUser,
  );
  allow();
  const [fresh] = await browser.resume("claim", signal(), first.pageId);
  assert.equal(fresh?.status, "ready");
  assert.ok(scripts.some((script) => script.includes("claimTaskSpace(42)")));
  assert.ok(scripts.every((script) => !script.includes("const receipt")));
  await browser.dispose();
});

test("an uncertain dispatched action cannot be cleared by resume or replayed", async () => {
  const { browser, allow, failAction, scripts } = fixture();
  allow();
  const first = await browser.open("https://example.test/article", signal());
  failAction();
  await assert.rejects(
    browser.act(first.pageId, first.version, first.elements[0]!.ref, undefined, signal()),
    /uncertain/,
  );
  const count = scripts.length;
  await assert.rejects(browser.resume("takeover", signal(), first.pageId), /不确定/);
  assert.equal(scripts.length, count);
  await browser.dispose();
});
