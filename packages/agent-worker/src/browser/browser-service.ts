import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page, type Locator } from "playwright";
import type { ToolRiskLevel } from "@semi-os/shared";
import { collectBrowserObservation } from "./browser-observation.ts";

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  href?: string;
  search: boolean;
  searchAction?: string;
  unsupported?: boolean;
}
export interface BrowserObservation {
  pageId: string;
  originalUrl: string;
  url: string;
  title: string;
  version: number;
  status: "ready" | "needs_user" | "failed";
  reason?: string;
  elements: BrowserElement[];
}
export interface BrowserPolicyEvidence {
  pageId: string;
  version: number;
  ref: string;
  role: string;
  href?: string;
  search: boolean;
  searchAction?: string;
}
interface PageState {
  page: Page;
  originalUrl: string;
  version: number;
  signature?: string;
  observation?: BrowserObservation;
  targets: Map<string, Locator>;
  tail: Promise<unknown>;
  cache?: { version: number; text: string };
  failure?: string;
}
export interface BrowserServiceOptions {
  profileDir?: string;
  headless?: boolean;
  timeoutMs?: number;
  timing?: (stage: string, durationMs: number) => void;
}

/** 只读调用可以把超时留作失败来源；变更调用仍由执行器判定 unknown。 */
export class BrowserOperationTimeout extends Error {
  readonly observation: BrowserObservation;
  constructor(observation: BrowserObservation) {
    super(observation.reason);
    this.observation = observation;
  }
}

/** 浏览器只执行 Pi 已请求的有界动作，不规划任务、不暴露 evaluate/script 工具。
 * 每页串行、全局最多两个动作；引用绑定 DOM 摘要，人工改页也会使旧引用失效。
 */
export class BrowserService {
  readonly profileDir: string;
  readonly #options: BrowserServiceOptions;
  readonly #pages = new Map<string, PageState>();
  #context?: Promise<BrowserContext>;
  #active = 0;
  #waiters: Array<() => void> = [];
  #disposed = false;

  constructor(options: BrowserServiceOptions = {}) {
    this.#options = options;
    this.profileDir =
      options.profileDir ??
      join(homedir(), "Library", "Application Support", "Semi-OS", "browser-profile");
  }
  async #launch(): Promise<BrowserContext> {
    if (this.#disposed) throw new Error("browser service disposed");
    this.#context ??= (async () => {
      const start = Date.now();
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.#options.headless ?? false,
        acceptDownloads: false,
        timeout: 12_000,
      });
      if (this.#disposed) {
        await context.close();
        throw new Error("browser service disposed");
      }
      // MVP 不提供下载上传能力，页面弹窗不自动确认。
      context.on("page", (page) =>
        page.on("dialog", (dialog) => {
          void dialog.dismiss();
        }),
      );
      context.setDefaultTimeout(this.#options.timeoutMs ?? 12_000);
      context.setDefaultNavigationTimeout(this.#timeoutMs);
      this.#options.timing?.("browser.startup", Date.now() - start);
      return context;
    })().catch((error) => {
      this.#context = undefined;
      throw error;
    });
    return this.#context;
  }
  async open(url: string, signal: AbortSignal): Promise<BrowserObservation> {
    assertWebUrl(url);
    signal.throwIfAborted();
    // 共享浏览器启动不因某个调用取消而终止，但调用方必须立即退出等待。
    const context = await waitForSignal(this.#launch(), signal);
    signal.throwIfAborted();
    const creating = context.newPage();
    void creating.then(
      (page) => {
        if (signal.aborted) void page.close().catch(() => {});
      },
      () => {},
    );
    const page = await waitForSignal(creating, signal);
    const id = `page_${randomUUID().replaceAll("-", "")}`;
    const state: PageState = {
      page,
      originalUrl: url,
      version: 0,
      targets: new Map(),
      tail: Promise.resolve(),
    };
    this.#pages.set(id, state);
    return this.#run<BrowserObservation>(id, signal, async () => {
      const start = Date.now();
      let reason: string | undefined;
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.#timeoutMs,
        });
        if (response && response.status() >= 400) reason = `HTTP ${response.status()}`;
      } catch {
        reason = "页面加载失败或超时";
      }
      state.failure = reason;
      this.#options.timing?.("browser.navigation", Date.now() - start);
      try {
        return await this.#observe(id, reason);
      } catch (error) {
        signal.throwIfAborted();
        if (page.isClosed()) throw error;
        // 导航失败后上下文可能仍在销毁；返回可记录的失败来源，不再次导航。
        return {
          pageId: id,
          originalUrl: url,
          url: page.url(),
          title: url,
          version: state.version,
          status: "failed",
          reason: reason ?? "页面导航尚未稳定，未获得可用观察",
          elements: [],
        };
      }
    }).catch((error: unknown) => {
      signal.throwIfAborted();
      if (error instanceof BrowserOperationTimeout) return error.observation;
      throw error;
    });
  }
  async observe(id: string, signal: AbortSignal): Promise<BrowserObservation> {
    return this.#run(id, signal, () => this.#observe(id));
  }
  async risk(
    id: string,
    version: number,
    ref: string,
    type: boolean,
    signal: AbortSignal,
  ): Promise<ToolRiskLevel> {
    return this.#run(id, signal, async () => {
      const { element } = await this.#target(id, version, ref);
      if (element.search && element.searchAction) return navigationRisk(element.searchAction);
      if (!type && element.role === "link" && element.href) {
        return navigationRisk(element.href);
      }
      return "external_side_effect";
    });
  }
  async policyEvidence(
    id: string,
    version: number,
    ref: string,
    signal: AbortSignal,
  ): Promise<BrowserPolicyEvidence> {
    return this.#run(id, signal, async () => {
      const { element } = await this.#target(id, version, ref);
      return { pageId: id, version, ...element };
    });
  }
  async act(
    id: string,
    version: number,
    ref: string,
    text: string | undefined,
    signal: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.#run(id, signal, async () => {
      const { locator, element } = await this.#target(id, version, ref);
      if (element.unsupported) throw new Error("首版不支持下载、上传或新窗口动作，请用户处理");
      if (text !== undefined) {
        if (!["textbox", "searchbox"].includes(element.role)) throw new Error("目标不是输入框");
        await locator.fill(text);
        if ((await locator.inputValue()) !== text) throw new Error("输入读回不一致");
      } else {
        await locator.click();
      }
      stateNavigationReset(this.#state(id));
      return this.#observe(id);
    });
  }
  async extract(id: string, offset: number, limit: number, signal: AbortSignal, region?: string) {
    return this.#run(id, signal, async () => {
      const start = Date.now();
      let observation = await this.#observe(id);
      if (observation.status !== "ready") throw new Error(observation.reason ?? "页面需要用户处理");
      const state = this.#state(id);
      let text: string;
      if (!region && state.cache?.version === observation.version) text = state.cache.text;
      else {
        const root = region
          ? state.page.getByRole("region", { name: region, exact: true })
          : state.page.locator("article, main, [role=main]").first();
        const target = region || (await root.count()) ? root : state.page.locator("body");
        if (region && (await target.count()) !== 1) throw new Error("区域不存在或有歧义");
        await target.waitFor({ state: "visible" });
        // 等正文条件而不是 sleep/networkidle；动态文章完成后重新绑定版本。
        await target.filter({ hasText: /\S/ }).waitFor({ state: "visible" });
        if (region) {
          const snapshot = await target.evaluate((node) => ({
            text: (node as HTMLElement).innerText.trim(),
            url: location.href,
            title: document.title,
          }));
          observation = await this.#observe(id);
          if (observation.url !== snapshot.url || observation.title !== snapshot.title)
            throw new Error("正文读取期间页面发生导航，请重新观察");
          text = snapshot.text;
        } else {
          // 正文、URL、标题在同一次 evaluate 中取快照。广告/时钟等页外变动
          // 仍会使动作 ref 失效，但不能把一份已原子读取的正文误判为失败。
          observation = await this.#observe(id);
          if (!state.cache || state.cache.version !== observation.version)
            throw new Error("正文尚未就绪，请重新观察或汇报已有资料");
          text = state.cache.text;
        }
        if (observation.status !== "ready")
          throw new Error(observation.reason ?? "页面需要用户处理");
      }
      this.#options.timing?.("browser.extraction", Date.now() - start);
      const segment = text.slice(offset, offset + limit);
      return {
        observation,
        text,
        segment,
        offset,
        nextOffset: offset + segment.length,
        truncated: offset + segment.length < text.length,
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      };
    });
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#context) await this.#context.then((context) => context.close()).catch(() => {});
    this.#pages.clear();
  }
  #state(id: string): PageState {
    const state = this.#pages.get(id);
    if (!state || state.page.isClosed()) throw new Error("页面不存在或已关闭");
    return state;
  }
  get #timeoutMs(): number {
    return this.#options.timeoutMs ?? 12_000;
  }
  async #target(id: string, version: number, ref: string) {
    const observation = await this.#observe(id);
    if (observation.version !== version) throw new Error("观察已过期，请重新 browser_extract");
    const state = this.#state(id);
    const element = observation.elements.find((item) => item.ref === ref);
    const locator = state.targets.get(ref);
    if (!element || !locator || (await locator.count()) !== 1)
      throw new Error("目标不存在或存在歧义，请重新观察");
    if (observation.status !== "ready") throw new Error(observation.reason);
    return { locator, element };
  }
  async #observe(id: string, failure?: string): Promise<BrowserObservation> {
    const state = this.#state(id);
    // 摘要包含正文与输入值：同 URL 的 SPA 更新、用户输入和延迟正文都会失效。
    const data = await state.page.evaluate(collectBrowserObservation);
    const signature = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    if (signature !== state.signature) {
      state.version++;
      state.signature = signature;
      state.cache = undefined;
    }
    if (data.content) state.cache = { version: state.version, text: data.content };
    state.targets.clear();
    const elements = data.elements
      .filter((el) => !!el.name && !!el.role && el.name.length <= 300)
      .map((el, index) => {
        const ref = `v${state.version}_${index}`;
        const locator =
          ["textbox", "searchbox"].includes(el.role) && !el.labelled && el.placeholder
            ? state.page.getByPlaceholder(el.placeholder, { exact: true })
            : state.page.getByRole(el.role as "button", { name: el.name, exact: true });
        state.targets.set(ref, locator);
        return {
          ref,
          role: el.role,
          name: el.name,
          href: el.href,
          search: el.search,
          searchAction: el.searchAction,
          unsupported: el.unsupported,
        };
      });
    const restricted =
      /captcha|验证码|access denied|访问受限|sign in to continue|登录后.*(?:查看|继续)/i.test(
        data.text.slice(0, 6000),
      );
    return (state.observation = {
      pageId: id,
      originalUrl: state.originalUrl,
      url: data.url,
      title: data.title,
      version: state.version,
      status: failure || state.failure ? "failed" : restricted ? "needs_user" : "ready",
      reason:
        failure ?? state.failure ?? (restricted ? "登录、验证码或访问限制需要用户处理" : undefined),
      elements,
    });
  }
  async #run<T>(id: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const state = this.#state(id);
    const previous = state.tail;
    const run = previous
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        if (this.#active >= 2) {
          await new Promise<void>((resolve, reject) => {
            const ready = () => {
              signal.removeEventListener("abort", cancel);
              resolve();
            };
            const cancel = () => {
              this.#waiters = this.#waiters.filter((waiter) => waiter !== ready);
              reject(signal.reason);
            };
            this.#waiters.push(ready);
            signal.addEventListener("abort", cancel, { once: true });
          });
        } else this.#active++;
        const cancel = () => {
          this.#pages.delete(id);
          void state.page.close().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          signal.throwIfAborted();
          // 单次动作的总预算覆盖 goto、条件等待和 evaluate，不让子步骤各自
          // 耗尽一轮超时。超时关闭页面，避免后台继续动作或返回迟到观察。
          const result = await Promise.race([
            action(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                cancel();
                reject(
                  new BrowserOperationTimeout({
                    ...state.observation,
                    pageId: id,
                    originalUrl: state.originalUrl,
                    url: state.page.url() === "about:blank" ? state.originalUrl : state.page.url(),
                    title: state.observation?.title || state.originalUrl,
                    version: Math.max(1, state.version),
                    status: "failed",
                    elements: [],
                    reason: "浏览器操作超时，页面已关闭；请汇报已有结果或选择其他来源",
                  }),
                );
              }, this.#timeoutMs);
            }),
          ]);
          signal.throwIfAborted();
          return result;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          // 直接把槽位转交等待者，避免新调用抢占已唤醒但尚未运行的槽位。
          const next = this.#waiters.shift();
          if (next) next();
          else this.#active--;
        }
      });
    state.tail = run;
    // 排队期间也及时响应取消，但队列槽位仍由原 Promise 按序交接。
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void run.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
}
/** 不取消共享资源的创建；仅撤销当前调用者的等待，避免插话被冷启动阻塞。 */
function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
function stateNavigationReset(state: PageState): void {
  state.failure = undefined;
}
/** URL 分类不接受模型声明：明确动作端点保守确认，常见文档导航/搜索可自动。 */
export function navigationRisk(value: string): ToolRiskLevel {
  assertWebUrl(value);
  const url = new URL(value);
  if (
    /logout|delete|remove|purchase|checkout|subscribe|send|publish|confirm|action=|token=|unsubscribe/i.test(
      decodeURIComponent(url.pathname + url.search),
    )
  )
    return "external_side_effect";
  return "read";
}
export function assertWebUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("仅允许不含凭证的 HTTP(S) URL");
}
