import { createHash } from "node:crypto";
import { accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_500_000;
const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /^(?!page[_-]?token$|next[_-]?page[_-]?token$).*(secret|password|credential|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key).*$/i;

export interface LarkCommandResult {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
}

export interface LarkCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
  ): Promise<LarkCommandResult>;
}

export interface LarkIdentity {
  displayName?: string;
  openId?: string;
  tenantName?: string;
  identityType?: "user" | "bot";
}

export interface LarkDocumentSearchResult {
  items: readonly Record<string, unknown>[];
  nextPageToken?: string;
}

export interface LarkChat {
  chatId: string;
  name?: string;
  description?: string;
}

export class LarkCommandError extends Error {
  readonly code:
    "unavailable" | "timeout" | "aborted" | "command_failed" | "invalid_output" | "unknown_send";

  constructor(code: LarkCommandError["code"], message: string) {
    super(message);
    this.name = "LarkCommandError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new LarkCommandError("invalid_output", "lark-cli returned invalid JSON");
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (!isRecord(value)) {
    if (typeof value === "string" && value.length > 100_000) return `${value.slice(0, 100_000)}…`;
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 500)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = sanitize(item, depth + 1);
    }
  }
  return output;
}

function requireString(value: unknown, label: string, maxLength = 20_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw new Error(`invalid ${label}`);
  return value;
}

function stableIdempotencyKey(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 40);
  return `so_${digest}`;
}

function findMessageText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value === text;
  if (Array.isArray(value)) return value.some((item) => findMessageText(item, text));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => findMessageText(item, text));
}

export class NodeLarkCommandRunner implements LarkCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
  ): Promise<LarkCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new LarkCommandError("aborted", "Lark operation cancelled")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new LarkCommandError("timeout", "Lark command timed out")));
      }, options.timeoutMs);
      options.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > options.maxOutputBytes) {
          child.kill("SIGTERM");
          finish(() =>
            reject(new LarkCommandError("invalid_output", "Lark command output is too large")),
          );
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8_000) stderr += chunk.toString("utf8").slice(0, 8_000);
      });
      child.once("error", (error) => {
        finish(() => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            reject(new LarkCommandError("unavailable", "lark-cli was not found"));
          else reject(new LarkCommandError("command_failed", "Lark CLI could not start"));
        });
      });
      child.once("close", (exitCode) => {
        finish(() => resolve({ stdout, stderr, exitCode }));
      });
    });
  }
}

export interface LarkServiceOptions {
  environment?: NodeJS.ProcessEnv;
  runner?: LarkCommandRunner;
  executable?: string;
  timeoutMs?: number;
  now?: () => number;
}

export class LarkService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: LarkCommandRunner;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly executable?: string;

  constructor(options: LarkServiceOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#runner = options.runner ?? new NodeLarkCommandRunner();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.executable =
      options.executable ??
      this.#environment.SEMI_OS_LARK_CLI_PATH ??
      this.findExecutable(this.#environment.PATH ?? "");
  }

  get available(): boolean {
    return Boolean(this.executable);
  }

  async capability(signal: AbortSignal): Promise<{
    available: boolean;
    version?: string;
    identity?: LarkIdentity;
    reason?: string;
  }> {
    if (!this.executable) return { available: false, reason: "lark-cli was not found on PATH" };
    try {
      const result = await this.run(["--version"], signal, 5_000);
      const version = result.stdout.trim().slice(0, 200);
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "Lark CLI unavailable",
      };
    }
  }

  async whoami(identityType: "user" | "bot", signal: AbortSignal): Promise<LarkIdentity> {
    const value = await this.command(["whoami", "--as", identityType, "--format", "json"], signal);
    if (!isRecord(value)) throw new LarkCommandError("invalid_output", "invalid Lark identity");
    return sanitize(value) as LarkIdentity;
  }

  async searchDocs(
    query: string,
    signal: AbortSignal,
    pageSize = 15,
  ): Promise<LarkDocumentSearchResult> {
    requireString(query, "query", 500);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20)
      throw new Error("pageSize must be 1..20");
    const value = await this.command(
      [
        "docs",
        "+search",
        "--query",
        query,
        "--page-size",
        String(pageSize),
        "--as",
        "user",
        "--format",
        "json",
      ],
      signal,
    );
    if (!isRecord(value))
      throw new LarkCommandError("invalid_output", "invalid Lark search result");
    const items = Array.isArray(value.items)
      ? value.items.filter(isRecord).map((item) => sanitize(item) as Record<string, unknown>)
      : Array.isArray(value.data) && isRecord(value.data)
        ? Array.isArray(value.data.items)
          ? value.data.items
              .filter(isRecord)
              .map((item) => sanitize(item) as Record<string, unknown>)
          : []
        : [];
    const nextPageToken =
      typeof value.page_token === "string"
        ? value.page_token
        : typeof value.pageToken === "string"
          ? value.pageToken
          : undefined;
    return { items, nextPageToken };
  }

  async fetchDoc(doc: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    requireString(doc, "doc", 2_000);
    const value = await this.command(
      [
        "docs",
        "+fetch",
        "--doc",
        doc,
        "--doc-format",
        "markdown",
        "--scope",
        "full",
        "--as",
        "user",
        "--format",
        "json",
      ],
      signal,
    );
    if (!isRecord(value)) throw new LarkCommandError("invalid_output", "invalid Lark document");
    return sanitize(value) as Record<string, unknown>;
  }

  async listChats(signal: AbortSignal, pageSize = 20): Promise<readonly LarkChat[]> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20)
      throw new Error("pageSize must be 1..20");
    const value = await this.command(
      [
        "im",
        "+chat-list",
        "--types",
        "p2p,group",
        "--page-size",
        String(pageSize),
        "--as",
        "user",
        "--format",
        "json",
      ],
      signal,
    );
    return this.extractChats(value);
  }

  async listChatMessages(chatId: string, signal: AbortSignal): Promise<unknown> {
    requireString(chatId, "chatId", 200);
    return this.command(
      ["im", "+chat-messages-list", "--chat-id", chatId, "--format", "json"],
      signal,
    );
  }

  async sendMessage(
    input: { chatId?: string; userId?: string; text: string; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if ((input.chatId && input.userId) || (!input.chatId && !input.userId))
      throw new Error("exactly one of chatId or userId is required");
    requireString(input.chatId ?? input.userId, "recipient", 200);
    requireString(input.text, "text", 20_000);
    const args = [
      "im",
      "+messages-send",
      input.chatId ? "--chat-id" : "--user-id",
      input.chatId ?? input.userId!,
      "--text",
      input.text,
      "--as",
      "user",
      "--idempotency-key",
      stableIdempotencyKey(input.idempotencyKey),
      "--format",
      "json",
    ];
    try {
      return await this.expectRecord(await this.command(args, signal), "Lark send result");
    } catch (error) {
      if (!(error instanceof LarkCommandError) || error.code !== "timeout") throw error;
      // A userId send has no stable chat history lookup in the bounded CLI
      // contract. Do not turn an empty chat id into a fake reconciliation
      // attempt or risk sending the same message twice.
      if (!input.chatId) {
        throw new LarkCommandError(
          "unknown_send",
          "Lark user send may have been applied; this target cannot be reconciled safely",
        );
      }
      const messages = await this.listChatMessages(input.chatId, signal).catch(() => undefined);
      if (messages !== undefined && findMessageText(messages, input.text)) {
        return {
          status: "reconciled",
          recipient: input.chatId,
          text: input.text,
          reconciledAtMs: this.#now(),
        };
      }
      throw new LarkCommandError(
        "unknown_send",
        "Lark message may have been sent; reconciliation could not prove the result",
      );
    }
  }

  private extractChats(value: unknown): readonly LarkChat[] {
    const candidates = isRecord(value)
      ? Array.isArray(value.items)
        ? value.items
        : isRecord(value.data) && Array.isArray(value.data.items)
          ? value.data.items
          : []
      : [];
    return candidates
      .filter(isRecord)
      .map((item) => ({
        chatId: String(item.chat_id ?? item.chatId ?? item.id ?? ""),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }))
      .filter((chat) => chat.chatId.length > 0);
  }

  private async command(args: readonly string[], signal: AbortSignal): Promise<unknown> {
    if (!this.executable) throw new LarkCommandError("unavailable", "lark-cli is unavailable");
    const result = await this.run(args, signal);
    if (result.exitCode !== 0)
      throw new LarkCommandError("command_failed", "Lark CLI rejected the request");
    return sanitize(parseJson(result.stdout));
  }

  private async run(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs = this.#timeoutMs,
  ): Promise<LarkCommandResult> {
    return this.#runner.run(this.executable!, args, {
      signal,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  private async expectRecord(value: unknown, label: string): Promise<Record<string, unknown>> {
    if (!isRecord(value)) throw new LarkCommandError("invalid_output", `invalid ${label}`);
    return value;
  }

  private findExecutable(pathValue: string): string | undefined {
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      const candidate = join(directory, "lark-cli");
      try {
        // This synchronous check is only used during Worker setup; command execution remains
        // asynchronous and is still bounded by the Runner.
        accessSync(candidate);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
    return undefined;
  }
}
