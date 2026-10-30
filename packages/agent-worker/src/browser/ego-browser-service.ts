import { createHash, randomUUID } from "node:crypto";
import type { ToolRiskLevel } from "@semi-os/shared";
import { BrowserNeedsUser, type BrowserBackend } from "./browser-backend.ts";
import {
  assertWebUrl,
  navigationRisk,
  type BrowserElement,
  type BrowserObservation,
  type BrowserPolicyEvidence,
} from "./browser-service.ts";
import { collectBrowserObservation, type BrowserPageData } from "./browser-observation.ts";
import { EgoStaleObservation, type EgoRunner } from "./ego-runner.ts";

interface EgoPage {
  label: string;
  originalUrl: string;
  version: number;
  signature?: string;
  data?: BrowserPageData;
  observation?: BrowserObservation;
}

/** Ego 只作为浏览器驱动，不成为第二个 Agent Loop。
 * 同一 Space 串行运行固定脚本，避免跨 CLI 进程争夺控制权。
 * 失败/取消后不重建 Space、不回退驱动，也不自动夺回用户控制权。
 */
export class EgoBrowserService implements BrowserBackend {
  readonly #runner: EgoRunner;
  readonly #name = `Semi-OS ${randomUUID()}`;
  readonly #pages = new Map<string, EgoPage>();
  readonly #timing?: (stage: string, durationMs: number) => void;
  #spaceId?: number;
  #tail: Promise<unknown> = Promise.resolve();
  #blocked?: string;
  #handoff = false;
  #disposed = false;

  constructor(runner: EgoRunner, timing?: (stage: string, durationMs: number) => void) {
    this.#runner = runner;
    this.#timing = timing;
  }

  open(url: string, signal: AbortSignal): Promise<BrowserObservation> {
    assertWebUrl(url);
    return this.#run(signal, async () => {
      const start = Date.now();
      const result = await this.#command(
        `const page = ${this.#spaceId === undefined ? 'task.page("p1")' : "await task.newPage()"};
await page.goto(${JSON.stringify(url)}, {waitUntil:"domcontentloaded", timeout:10000});
await page.snapshot({scope:"full_page"});
const data = await page.evaluate(${collectBrowserObservation.toString()});
return {spaceId:task.spaceId, label:page.label, data};`,
        signal,
      );
      const id = `ego_${randomUUID().replaceAll("-", "")}`;
      const page: EgoPage = { label: result.label, originalUrl: url, version: 0 };
      this.#pages.set(id, page);
      this.#timing?.("browser.navigation", Date.now() - start);
      return this.#accept(id, page, result.data, signal);
    });
  }

  observe(id: string, signal: AbortSignal): Promise<BrowserObservation> {
    return this.#run(signal, () => this.#observe(id, signal));
  }

  risk(
    id: string,
    version: number,
    ref: string,
    type: boolean,
    signal: AbortSignal,
  ): Promise<ToolRiskLevel> {
    return this.#run(signal, async () => {
      const { element } = await this.#target(id, version, ref, signal);
      if (element.search && element.searchAction) return navigationRisk(element.searchAction);
      if (!type && element.role === "link" && element.href) return navigationRisk(element.href);
      return "external_side_effect";
    });
  }

  policyEvidence(
    id: string,
    version: number,
    ref: string,
    signal: AbortSignal,
  ): Promise<BrowserPolicyEvidence> {
    return this.#run(signal, async () => {
      const { element } = await this.#target(id, version, ref, signal);
      return { pageId: id, version, ...element };
    });
  }

  act(
    id: string,
    version: number,
    ref: string,
    text: string | undefined,
    signal: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.#run(signal, async () => {
      const { page, element, target } = await this.#target(id, version, ref, signal);
      if (element.unsupported) throw new Error("首版不支持下载、上传或新窗口动作，请用户处理");
      if (text !== undefined && !["textbox", "searchbox"].includes(element.role))
        throw new Error("目标不是输入框");
      const selector =
        ["textbox", "searchbox"].includes(target.role) && !target.labelled && target.placeholder
          ? `loc=css:input[placeholder=${JSON.stringify(target.placeholder)}],textarea[placeholder=${JSON.stringify(target.placeholder)}]`
          : `loc=role:${target.role}[name=${JSON.stringify(target.name)}]`;
      const result = await this.#command(
        `${this.#pageScript(page)}
// 审批后的最终校验与动作在同一 CLI 调用内；不接受跨调用过期引用。
const before = await page.evaluate(${collectBrowserObservation.toString()});
const {createHash} = await import("node:crypto");
if (createHash("sha256").update(JSON.stringify(before)).digest("hex") !== ${JSON.stringify(page.signature)})
  throw Object.assign(new Error("stale"), {code:"SEMI_OS_STALE"});
${
  text === undefined
    ? `const receipt = await page.click(${JSON.stringify(selector)}, {timeout:6000, label:"Semi-OS click target"});
if (receipt?.executionStopped || receipt?.mayHaveLateEffects) {
  throw Object.assign(new Error("Ego click result is uncertain"), {code:"SEMI_OS_UNKNOWN"});
}`
    : `const receipt = await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(text)}, {timeout:6000});
if (receipt?.executionStopped || receipt?.mayHaveLateEffects) {
  throw Object.assign(new Error("Ego fill result is uncertain"), {code:"SEMI_OS_UNKNOWN"});
}`
}
const data = await page.evaluate(${collectBrowserObservation.toString()});
return {spaceId:task.spaceId, label:page.label, data};`,
        signal,
      );
      if (text !== undefined) {
        const matches = result.data.elements.filter((item) => sameTarget(item, target));
        if (matches.length !== 1 || matches[0]?.value !== text) {
          this.#blocked = "输入后的读回不一致，请检查原 Space；不会自动重试";
          throw new Error(this.#blocked);
        }
      }
      return this.#accept(id, page, result.data, signal);
    });
  }

  extract(id: string, offset: number, limit: number, signal: AbortSignal, region?: string) {
    return this.#run(signal, async () => {
      const start = Date.now();
      const page = this.#state(id);
      // 等待正文条件，不固定 sleep；无正文就明确失败，不伪装已完整阅读。
      const result = await this.#command(
        `${this.#pageScript(page)}
const region = ${JSON.stringify(region ?? null)};
await page.waitForFunction((name) => {
  const roots = name === null
    ? [document.querySelector("article,main,[role=main]") || document.body]
    : Array.from(document.querySelectorAll('[role="region"]')).filter(el => {
        const labelled = el.getAttribute("aria-labelledby")?.split(/\\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
        return (labelled || el.getAttribute("aria-label") || "").trim() === name;
      });
  return roots.length === 1 && !!roots[0]?.innerText?.trim();
}, region, {timeout:6000});
const data = await page.evaluate(${collectBrowserObservation.toString()});
const section = region === null ? null : await page.evaluate((name) => {
  const roots = Array.from(document.querySelectorAll('[role="region"]')).filter(el => {
    const labelled = el.getAttribute("aria-labelledby")?.split(/\\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
    return (labelled || el.getAttribute("aria-label") || "").trim() === name;
  });
  if (roots.length !== 1) throw new Error("ambiguous region");
  return {text:roots[0].innerText.trim(), url:location.href, title:document.title};
}, region);
if (section && (section.url !== data.url || section.title !== data.title)) throw new Error("navigation changed");
if (section) data.content = section.text;
return {spaceId:task.spaceId, label:page.label, data};`,
        signal,
      );
      // 区域正文不覆盖整页动作签名，否则后续同页操作会错误过期。
      const text = result.data.content;
      const observation = await this.#observe(id, signal);
      if (observation.status === "needs_user") throw new BrowserNeedsUser(observation);
      if (observation.status !== "ready") throw new Error(observation.reason);
      if (observation.url !== result.data.url || observation.title !== result.data.title)
        throw new Error("正文读取期间页面发生导航，请重新观察");
      this.#timing?.("browser.extraction", Date.now() - start);
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

  /** 用户明确点击继续后才能恢复。串行队列仍阻止恢复期间的任何页面动作；
   * 即使 DOM 未变，也撤销旧版本，避免人工接管前的审批/引用继续有效。
   */
  resume(
    mode: "takeover" | "claim",
    signal: AbortSignal,
    pageId: string,
  ): Promise<BrowserObservation[]> {
    return this.#run(
      signal,
      async () => {
        if (!this.#handoff || this.#spaceId === undefined)
          throw new Error("没有可恢复的用户接管；不确定动作不能通过继续按钮重试");
        this.#state(pageId);
        const spaceId = this.#spaceId;
        const raw = await this.#runner(
          `const task = await ${mode === "claim" ? "claimTaskSpace" : "takeOverTaskSpace"}(${spaceId});
return {spaceId:task.spaceId};`,
          signal,
        );
        if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).spaceId !== spaceId)
          throw new Error("恢复的 Ego Space 不匹配");
        signal.throwIfAborted();
        this.#blocked = undefined;
        this.#handoff = false;
        for (const page of this.#pages.values()) {
          page.version++;
          page.signature = undefined;
          page.data = undefined;
          page.observation = undefined;
        }
        try {
          // 只刷新挂起点的原页面；无关旧标签可能已关闭或仍在登录页，
          // 不能阻塞本次恢复。其他页面旧引用已统一撤销，使用时再观察。
          return [await this.#observe(pageId, signal)];
        } catch (error) {
          // 观察失败时保留现场并交还；绝不创建替代 Space 或自动 claim。
          this.#blocked = "恢复后无法核验原页面，请检查原 Space 后重试";
          this.#handoff = true;
          await this.#runner(
            `const task = await taskSpace(${spaceId}); await task.handOff(); return null;`,
            AbortSignal.timeout(3000),
          ).catch(() => {});
          throw error;
        }
      },
      true,
    );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#tail.catch(() => {});
    // 退出只交还控制，保留用户可见现场；不以关闭 Worker 冒充调研成功 finish。
    if (this.#spaceId !== undefined && !this.#blocked) {
      await this.#runner(
        `const task = await taskSpace(${this.#spaceId}); await task.handOff(); return null;`,
        AbortSignal.timeout(3000),
      ).catch(() => {});
    }
    this.#pages.clear();
  }

  #state(id: string): EgoPage {
    const page = this.#pages.get(id);
    if (!page) throw new Error("页面不存在或已关闭");
    return page;
  }
  #pageScript(page: EgoPage): string {
    return `const page = task.page(${JSON.stringify(page.label)});`;
  }
  async #command(script: string, signal: AbortSignal) {
    try {
      const raw = await this.#runner(
        `const task = await taskSpace(${JSON.stringify(this.#spaceId ?? this.#name)});\n${script}`,
        signal,
      );
      const result = validateEgoResult(raw);
      if (this.#spaceId !== undefined && this.#spaceId !== result.spaceId)
        throw new Error("Ego 返回了不匹配的 Space");
      this.#spaceId = result.spaceId;
      return result;
    } catch (error) {
      if (!(error instanceof EgoStaleObservation))
        this.#blocked =
          "Ego 浏览器操作结果不明或已交还控制，请检查原 Space 后重新启动助手；不会回退或重试";
      throw error;
    }
  }
  async #observe(id: string, signal: AbortSignal): Promise<BrowserObservation> {
    const page = this.#state(id);
    const result = await this.#command(
      `${this.#pageScript(page)}
await page.snapshot({scope:"full_page"});
const data = await page.evaluate(${collectBrowserObservation.toString()});
return {spaceId:task.spaceId, label:page.label, data};`,
      signal,
    );
    if (result.label !== page.label) throw new Error("Ego 返回了不匹配的页面");
    return this.#accept(id, page, result.data, signal);
  }
  async #accept(id: string, page: EgoPage, data: BrowserPageData, signal: AbortSignal) {
    const signature = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    if (page.signature !== signature) page.version++;
    page.signature = signature;
    page.data = data;
    const restricted =
      /captcha|验证码|access denied|访问受限|sign in to continue|登录后.*(?:查看|继续)/i.test(
        data.text.slice(0, 6000),
      );
    const elements: BrowserElement[] = data.elements
      .filter((el) => !!el.name && !!el.role && el.name.length <= 300)
      .map((el, index) => ({
        ref: `v${page.version}_${index}`,
        role: el.role,
        name: el.name,
        href: el.href,
        search: el.search,
        searchAction: el.searchAction,
        unsupported: el.unsupported,
      }));
    const observation: BrowserObservation = {
      pageId: id,
      originalUrl: page.originalUrl,
      url: data.url,
      title: data.title,
      version: page.version,
      status: restricted ? "needs_user" : "ready",
      reason: restricted ? "登录、验证码或访问限制需要用户处理，请在 Ego Space 中操作" : undefined,
      elements,
    };
    page.observation = observation;
    if (restricted) {
      this.#blocked = "Ego Space 已交给用户，请完成操作后在客户端继续";
      this.#handoff = true;
      await this.#runner(
        `const task = await taskSpace(${this.#spaceId}); await task.handOff(); return null;`,
        signal,
      );
    }
    return observation;
  }
  async #target(id: string, version: number, ref: string, signal: AbortSignal) {
    const observation = await this.#observe(id, signal);
    if (observation.status === "needs_user") throw new BrowserNeedsUser(observation);
    if (observation.status !== "ready") throw new Error(observation.reason);
    if (observation.version !== version) throw new EgoStaleObservation();
    const page = this.#state(id);
    const element = observation.elements.find((item) => item.ref === ref);
    const targets = page.data!.elements.filter(
      (el) => !!el.name && !!el.role && el.name.length <= 300,
    );
    const target = targets[observation.elements.findIndex((item) => item.ref === ref)];
    if (
      !element ||
      !target ||
      page.data!.elements.filter((el) => sameTarget(el, target)).length !== 1
    )
      throw new Error("目标不存在或存在歧义，请重新观察");
    return { page, element, target };
  }
  #run<T>(signal: AbortSignal, operation: () => Promise<T>, allowHandoff = false): Promise<T> {
    const result = this.#tail
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        if (this.#disposed) throw new Error("browser service disposed");
        if (this.#blocked && !allowHandoff) {
          const restricted = this.#handoff
            ? [...this.#pages.values()].find((page) => page.observation?.status === "needs_user")
                ?.observation
            : undefined;
          if (restricted) throw new BrowserNeedsUser(restricted);
          throw new Error(this.#blocked);
        }
        return operation();
      });
    this.#tail = result;
    // 排队取消及时返回；真正轮到该调用时仍检查 signal，不会继续操作浏览器。
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
}

function sameTarget(
  a: BrowserPageData["elements"][number],
  b: BrowserPageData["elements"][number],
) {
  return (
    a.role === b.role &&
    (b.placeholder && !b.labelled ? a.placeholder === b.placeholder : a.name === b.name)
  );
}

/** 外部 CLI 的页面数据逐字段校验，不把 JSON 强转成内部观察或策略证据。 */
export function validateEgoResult(value: unknown): {
  spaceId: number;
  label: string;
  data: BrowserPageData;
} {
  if (!value || typeof value !== "object") throw new Error("invalid Ego result");
  const raw = value as Record<string, unknown>;
  const data = raw.data as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(raw.spaceId) ||
    Number(raw.spaceId) < 1 ||
    typeof raw.label !== "string" ||
    !/^p[1-9]\d*$/.test(raw.label) ||
    !data ||
    typeof data !== "object" ||
    !["text", "content", "title", "url"].every((key) => typeof data[key] === "string") ||
    String(data.text).length > 1_000_000 ||
    String(data.content).length > 1_000_000 ||
    !Array.isArray(data.elements) ||
    data.elements.length > 60
  )
    throw new Error("invalid Ego observation");
  assertWebUrl(String(data.url));
  for (const item of data.elements) {
    if (
      !item ||
      typeof item !== "object" ||
      !["role", "name", "value"].every((key) => typeof item[key] === "string") ||
      !["labelled", "search", "unsupported"].every((key) => typeof item[key] === "boolean") ||
      !["placeholder", "href", "searchAction"].every(
        (key) => item[key] === undefined || typeof item[key] === "string",
      )
    )
      throw new Error("invalid Ego target");
    if (item.href && /^https?:/.test(item.href)) assertWebUrl(item.href);
    if (item.searchAction) assertWebUrl(item.searchAction);
  }
  return value as { spaceId: number; label: string; data: BrowserPageData };
}
