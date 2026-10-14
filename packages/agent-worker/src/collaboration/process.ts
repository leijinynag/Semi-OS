import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLine(line: string): void;
  onExit(code: number | null): void;
  onError(error: Error): void;
}
export interface ProcessPort {
  write(value: unknown): void;
  stop(): Promise<void>;
}

/** 仅以 LF 分帧；readline 会把模型正文中的 Unicode 分隔符误当协议边界。 */
export class JsonLines {
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  readonly receive: (line: string) => void;
  readonly limit: number;
  constructor(receive: (line: string) => void, limit = 1_048_576) {
    this.receive = receive;
    this.limit = limit;
  }
  push(chunk: Uint8Array): void {
    this.#pending += this.#decoder.write(Buffer.from(chunk));
    let newline: number;
    while ((newline = this.#pending.indexOf("\n")) >= 0) {
      const line = this.#pending.slice(0, newline).replace(/\r$/, "");
      this.#pending = this.#pending.slice(newline + 1);
      if (Buffer.byteLength(line) > this.limit) throw new Error("process frame limit exceeded");
      if (line) this.receive(line);
    }
    if (Buffer.byteLength(this.#pending) > this.limit)
      throw new Error("process frame limit exceeded");
  }
}

/** 子进程属于 Worker 独立进程组；取消先 TERM，超时 KILL 整组，不能遗留 shell 后代。 */
export class PipeProcess implements ProcessPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #closed: Promise<void>;
  #exited = false;
  constructor(options: ProcessOptions) {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.#child = child;
    const lines = new JsonLines(options.onLine);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        lines.push(chunk);
      } catch (cause) {
        options.onError(cause instanceof Error ? cause : new Error("invalid frame"));
        void this.stop();
      }
    });
    // 不把原始 stderr 转发客户端，CLI 可能输出凭证、环境变量或内部推理。
    child.stderr.resume();
    child.stdin.on("error", () => options.onError(new Error("provider input closed")));
    child.on("error", () => options.onError(new Error("provider process unavailable")));
    this.#closed = new Promise((resolve) =>
      child.once("close", (code) => {
        this.#exited = true;
        options.onExit(code);
        resolve();
      }),
    );
  }
  write(value: unknown): void {
    if (this.#exited || !this.#child.stdin.writable)
      throw new Error("provider process is not writable");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  async stop(): Promise<void> {
    if (this.#exited) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.#child.pid) process.kill(-this.#child.pid, signal);
        else this.#child.kill(signal);
      } catch {
        /* 进程可能已经退出，close 是唯一最终状态来源。 */
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1_500);
    try {
      await this.#closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseProcessObject(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid provider object");
  return value as Record<string, unknown>;
}
