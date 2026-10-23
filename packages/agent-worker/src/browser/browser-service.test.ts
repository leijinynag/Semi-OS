import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, navigationRisk } from "./browser-service.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { executeProductTool } from "../tool-execution.ts";
import type { ResearchSource } from "@semi-os/protocol";

const signal = () => new AbortController().signal;
test("four bounded tools: search, stale/ambiguous refs, evidence, restrictions and profile reuse", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "semi-research-"));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/article" });
      response.end();
      return;
    }
    if (request.url === "/cookie") {
      response.setHeader("Set-Cookie", "fixture=logged-in; Max-Age=3600; Path=/");
      response.end("<main>用户登录已保存</main>");
      return;
    }
    if (request.url === "/profile") {
      response.end(`<main>${request.headers.cookie ?? "未登录"}</main>`);
      return;
    }
    if (request.url === "/blocked") {
      response.end("<title>受限资料</title><main>登录后继续查看</main>");
      return;
    }
    if (request.url === "/duplicate") {
      response.end("<button>重复</button><button>重复</button>");
      return;
    }
    if (request.url === "/fake-search") {
      response.end(
        '<form role="search" action="/delete"><input type="search" aria-label="搜索"><button>搜索</button></form>',
      );
      return;
    }
    if (request.url === "/delayed") {
      response.end(
        '<main></main><script>setTimeout(()=>document.querySelector("main").textContent="延迟正文",150)</script>',
      );
      return;
    }
    if (request.url === "/dynamic") {
      response.end(
        '<title>动态页面</title><aside id="clock"></aside><article>稳定的研究正文。</article><script>setInterval(()=>document.querySelector("#clock").textContent=String(performance.now()),1)</script>',
      );
      return;
    }
    if (request.url?.startsWith("/search")) {
      response.end(
        '<title>搜索</title><main><a href="/article">来源一</a><a href="/conflict">来源二</a></main>',
      );
      return;
    }
    if (request.url === "/article" || request.url === "/conflict") {
      response.end(
        `<title>${request.url === "/article" ? "来源一" : "来源二"}</title><article>${request.url === "/article" ? "研究结论：支持自动搜索。" : "研究结论：仅支持手动搜索。"}${"长文章".repeat(100)}</article>`,
      );
      return;
    }
    response.end(
      '<title>调研入口</title><form role="search" action="/search" method="get"><label>关键词<input name="q" type="search"></label><button>搜索</button></form><button>发送消息</button><a href="/article">正文</a>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let browser = new BrowserService({ profileDir: profile, headless: true, timeoutMs: 2000 });
  t.after(async () => {
    await browser.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  });
  const sources: ResearchSource[] = [];
  const tools = createBrowserTools(browser, {
    save: async (source) => {
      sources.push(source);
    },
  });
  const tool = (name: string) => tools.find((item) => item.name === name)!;
  const context = {
    taskId: "task_fixture",
    attemptId: "a",
    attemptNumber: 1,
    idempotencyKey: "k",
    signal: signal(),
    startedAtMs: Date.now(),
  };
  const entry = await tool("browser_open").execute({ url: base }, context);
  const page = String(entry.output.pageId);
  const observation = await browser.observe(page, signal());
  const search = observation.elements.find((el) => el.name === "关键词")!;
  assert.equal(await browser.risk(page, observation.version, search.ref, true, signal()), "read");
  const typed = await tool("browser_type").execute(
    { pageId: page, version: observation.version, ref: search.ref, text: "资料" },
    context,
  );
  assert.equal(typed.output.url, `${base}/`);
  await assert.rejects(
    browser.act(page, observation.version, search.ref, "旧输入", signal()),
    /过期/,
  );
  const next = await browser.observe(page, signal());
  const submit = next.elements.find((el) => el.name === "搜索")!;
  const searched = await browser.act(page, next.version, submit.ref, undefined, signal());
  assert.match(searched.url, /search\?q=/);
  const sourceLink = searched.elements.find((el) => el.name === "来源一")!;
  const article = await browser.act(page, searched.version, sourceLink.ref, undefined, signal());
  assert.equal(article.title, "来源一");
  const first = await tool("browser_extract").execute({ pageId: page, limit: 30 }, context);
  const second = await tool("browser_extract").execute(
    { pageId: page, offset: first.output.nextOffset, limit: 6000 },
    context,
  );
  assert.equal(first.output.truncated, true);
  assert.equal(second.output.truncated, false);
  assert.equal(sources[0]!.text!.slice(0, 30), sources[0]!.quotes[0]!.text);
  assert.equal(first.output.digest, second.output.digest);
  const duplicate = await browser.open(`${base}/duplicate`, signal());
  await assert.rejects(
    browser.act(
      duplicate.pageId,
      duplicate.version,
      duplicate.elements[0]!.ref,
      undefined,
      signal(),
    ),
    /歧义/,
  );
  const redirected = await browser.open(`${base}/redirect`, signal());
  assert.equal(redirected.originalUrl, `${base}/redirect`);
  assert.equal(redirected.url, `${base}/article`);
  const delayed = await browser.open(`${base}/delayed`, signal());
  assert.equal((await browser.extract(delayed.pageId, 0, 100, signal())).segment, "延迟正文");
  const blocked = await tool("browser_open").execute({ url: `${base}/blocked` }, context);
  assert.equal(blocked.resultType, "needs_user");
  assert.equal(sources.at(-1)!.status, "needs_user");
  const restrictedRead = await tool("browser_extract").execute(
    { pageId: blocked.output.pageId },
    context,
  );
  assert.equal(restrictedRead.resultType, "needs_user");
  assert.equal(sources.at(-1)!.status, "needs_user");
  const dynamic = await browser.open(`${base}/dynamic`, signal());
  for (let count = 0; count < 5; count++) {
    const extracted = await browser.extract(dynamic.pageId, 0, 100, signal());
    assert.equal(extracted.text, "稳定的研究正文。");
    assert.equal(extracted.observation.title, "动态页面");
  }
  const denied = await executeProductTool({
    tool: tool("browser_click"),
    input: { pageId: page, version: article.version, ref: "nonexistent" },
    identity: context,
    signal: signal(),
    policyDecision: "confirmation_required",
    now: Date.now,
  }).then(
    () => undefined,
    (error: { receipt: { status: string } }) => error.receipt,
  );
  assert.equal(denied?.status, "needs_user");
  assert.equal(navigationRisk(`${base}/delete?id=1`), "external_side_effect");
  const fakeSearch = await browser.open(`${base}/fake-search`, signal());
  assert.equal(
    await browser.risk(
      fakeSearch.pageId,
      fakeSearch.version,
      fakeSearch.elements[0]!.ref,
      true,
      signal(),
    ),
    "external_side_effect",
  );
  await browser.open(`${base}/cookie`, signal());
  await browser.dispose();
  browser = new BrowserService({ profileDir: profile, headless: true });
  const logged = await browser.open(`${base}/profile`, signal());
  assert.match((await browser.extract(logged.pageId, 0, 100, signal())).text, /fixture=logged-in/);
});

test("cancels in-flight browser extraction and prevents reuse of cancelled page", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "semi-cancel-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<main></main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = new BrowserService({ profileDir: profile, headless: true });
  t.after(async () => {
    await browser.dispose();
    server.close();
    await rm(profile, { recursive: true, force: true });
  });
  const page = await browser.open(`http://127.0.0.1:${address.port}`, signal());
  const controller = new AbortController();
  const extraction = browser.extract(page.pageId, 0, 100, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(extraction);
  await assert.rejects(browser.observe(page.pageId, signal()), /关闭/);
});

test("independent pages use at most two slots and same-page reads are serialized", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "semi-concurrent-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<main></main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = new BrowserService({ profileDir: profile, headless: true, timeoutMs: 300 });
  t.after(async () => {
    await browser.dispose();
    server.close();
    await rm(profile, { recursive: true, force: true });
  });
  const pages = await Promise.all(
    Array.from({ length: 3 }, () => browser.open(`http://127.0.0.1:${address.port}`, signal())),
  );
  // 两个空正文的条件等待占用槽位，第三页普通观察也必须排队。
  const reads = pages
    .slice(0, 2)
    .map((page) => browser.extract(page.pageId, 0, 100, signal()).catch(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 50));
  let observed = false;
  const queued = browser.observe(pages[2]!.pageId, signal()).then(() => {
    observed = true;
  });
  let samePageObserved = false;
  const samePage = browser.observe(pages[0]!.pageId, signal()).then(
    () => {
      samePageObserved = true;
    },
    (error: Error) => {
      assert.match(error.message, /关闭/);
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed, false);
  assert.equal(samePageObserved, false);
  await Promise.all([...reads, queued, samePage]);
  assert.equal(observed, true);
});

test("hung navigation and empty-body reads have bounded waits and persist failed sources", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "semi-timeout-"));
  const server = createServer((request, response) => {
    if (request.url === "/hang") return;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<main></main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const browser = new BrowserService({ profileDir: profile, headless: true, timeoutMs: 500 });
  t.after(async () => {
    await browser.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  });
  const sources: ResearchSource[] = [];
  const tools = createBrowserTools(browser, {
    save: async (source) => {
      sources.push(source);
    },
  });
  const context = {
    taskId: "task_timeout",
    attemptId: "a",
    attemptNumber: 1,
    idempotencyKey: "k",
    signal: signal(),
    startedAtMs: Date.now(),
  };
  const empty = await browser.open(base, signal());
  const started = Date.now();
  const hung = await tools
    .find((tool) => tool.name === "browser_open")!
    .execute({ url: `${base}/hang` }, context);
  assert.equal(hung.resultType, "failure");
  assert.equal(sources.at(-1)?.originalUrl, `${base}/hang`);
  assert.match(sources.at(-1)!.reason!, /超时/);
  const read = await tools
    .find((tool) => tool.name === "browser_extract")!
    .execute({ pageId: empty.pageId }, context);
  assert.equal(read.resultType, "failure");
  assert.equal(sources.at(-1)?.originalUrl, base);
  assert.ok(
    Date.now() - started < 5000,
    "fixture must not inherit unbounded evaluate/navigation waits",
  );
  await assert.rejects(browser.observe(empty.pageId, signal()), /关闭/);
});
