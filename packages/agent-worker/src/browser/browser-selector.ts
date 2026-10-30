import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserBackend } from "./browser-backend.ts";
import { BrowserService, type BrowserServiceOptions } from "./browser-service.ts";
import { createEgoRunner } from "./ego-runner.ts";
import { EgoBrowserService } from "./ego-browser-service.ts";

export interface BrowserSelectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  browser?: BrowserBackend;
  playwright?: BrowserServiceOptions;
  timing?: (stage: string, durationMs: number) => void;
  commandExists?: (path: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  pathExists?: (path: string) => Promise<boolean>;
}

export interface BrowserSelection {
  backend: "ego" | "playwright";
  executable?: string;
  appPath?: string;
}

/**
 * Ego Lite 的安装检测只决定“首次选择哪个后端”。
 * 一旦选中 Ego，后续连接、控制权和页面动作失败都不会偷偷重放到 Playwright，
 * 避免同一个外部动作在两个浏览器中重复执行。
 */
export class AutomaticBrowserBackend implements BrowserBackend {
  readonly #options: BrowserSelectionOptions;
  #selection?: Promise<BrowserSelection>;
  #backendPromise?: Promise<BrowserBackend>;
  #disposePromise?: Promise<void>;
  #disposed = false;
  #supportsResume = false;

  constructor(options: BrowserSelectionOptions = {}) {
    this.#options = options;
    this.#supportsResume =
      Boolean(options.browser?.resume) && options.browser?.supportsResume !== false;
  }

  async open(...args: Parameters<BrowserBackend["open"]>) {
    return this.#backend().then((backend) => backend.open(...args));
  }
  async observe(...args: Parameters<BrowserBackend["observe"]>) {
    return this.#backend().then((backend) => backend.observe(...args));
  }
  async risk(...args: Parameters<BrowserBackend["risk"]>) {
    return this.#backend().then((backend) => backend.risk(...args));
  }
  async policyEvidence(...args: Parameters<BrowserBackend["policyEvidence"]>) {
    return this.#backend().then((backend) => backend.policyEvidence(...args));
  }
  async act(...args: Parameters<BrowserBackend["act"]>) {
    return this.#backend().then((backend) => backend.act(...args));
  }
  async extract(...args: Parameters<BrowserBackend["extract"]>) {
    return this.#backend().then((backend) => backend.extract(...args));
  }
  get supportsResume(): boolean {
    return this.#supportsResume;
  }
  async resume(mode: "takeover" | "claim", signal: AbortSignal, pageId: string) {
    const backend = await this.#backend();
    if (!backend.resume) throw new Error("当前浏览器不支持 Space 恢复，请在原页面处理");
    return backend.resume(mode, signal, pageId);
  }
  dispose(): Promise<void> {
    this.#disposed = true;
    // 释放与初始化共享同一 Promise；不允许迟到初始化绕过退出，也不重复交还 Space。
    this.#disposePromise ??= (async () => {
      const backend = await this.#backendPromise?.catch(() => undefined);
      await backend?.dispose();
    })();
    return this.#disposePromise;
  }

  async selection(): Promise<BrowserSelection> {
    this.#selection ??= selectBrowserBackend(this.#options);
    return this.#selection;
  }

  async #backend(): Promise<BrowserBackend> {
    if (this.#disposed) throw new Error("浏览器后端已释放");
    // 首次并发请求必须共享实例；失败同样保留，不能换后端重放已请求的动作。
    this.#backendPromise ??= this.#createBackend();
    const backend = await this.#backendPromise;
    this.#supportsResume = Boolean(backend.resume) && backend.supportsResume !== false;
    if (this.#disposed) throw new Error("浏览器后端已释放");
    return backend;
  }

  async #createBackend(): Promise<BrowserBackend> {
    if (this.#options.browser) return this.#options.browser;
    const selection = await this.selection();
    if (selection.backend === "ego") {
      return new EgoBrowserService(
        createEgoRunner(selection.executable!, {
          env: this.#options.env,
        }),
        this.#options.timing,
      );
    }
    return new BrowserService(this.#options.playwright);
  }
}

export async function selectBrowserBackend(
  options: BrowserSelectionOptions = {},
): Promise<BrowserSelection> {
  if (options.browser) return { backend: "playwright" };
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? defaultPathExists;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const appPath = await findEgoAppPath(platform, env, pathExists);
  if (!appPath) return { backend: "playwright" };

  const executable = await findEgoCliPath(platform, env, commandExists);
  if (!executable) {
    throw new Error(
      `检测到 Ego Lite（${appPath}），但未找到 ego-browser CLI。请完成 Ego Lite 首次安装，或将 CLI 加入 PATH；不会回退到 Playwright。`,
    );
  }
  return { backend: "ego", executable, appPath };
}

async function findEgoAppPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  const explicit = env.SEMI_OS_EGO_APP_PATH?.trim();
  if (explicit && (await pathExists(explicit))) return explicit;
  const home = env.HOME || homedir();
  const candidates =
    platform === "darwin"
      ? ["/Applications/ego lite.app", join(home, "Applications", "ego lite.app")]
      : platform === "win32"
        ? [
            join(env.ProgramFiles ?? "C:\\Program Files", "ego lite", "ego lite.exe"),
            join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ego lite", "ego lite.exe"),
          ]
        : [join(home, ".local", "share", "ego lite"), join(home, ".local", "share", "ego-lite")];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function findEgoCliPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  commandExists: (path: string, env: NodeJS.ProcessEnv) => Promise<boolean>,
): Promise<string | undefined> {
  const explicit = env.SEMI_OS_EGO_CLI_PATH?.trim();
  if (explicit && (await commandExists(explicit, env))) return explicit;
  const home = env.HOME || homedir();
  const candidates =
    platform === "win32"
      ? ["ego-browser.exe", "ego-browser.cmd", "ego-browser"]
      : ["ego-browser", join(home, ".local", "bin", "ego-browser")];
  for (const candidate of candidates) {
    if (await commandExists(candidate, env)) return candidate;
  }
  return undefined;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) return defaultPathExists(command);
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidates =
      env.PATHEXT && process.platform === "win32"
        ? [command, ...env.PATHEXT.split(";").map((suffix) => `${command}${suffix}`)]
        : [command];
    for (const candidate of candidates) {
      if (await defaultPathExists(join(directory, candidate))) return true;
    }
  }
  return false;
}
