import { spawn, type IPty } from "node-pty";

export interface TerminalOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onData(data: string): void;
  onExit(code: number): void;
}

/** PTY 用于需要真实终端的 Provider；结构化 JSONL 默认仍走管道，避免回显和 ANSI 污染协议。 */
export class AgentTerminal {
  readonly #pty: IPty;
  readonly #closed: Promise<void>;
  #exited = false;
  #stopping?: Promise<void>;
  constructor(options: TerminalOptions) {
    const env =
      options.env ??
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    this.#pty = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      cols: 100,
      rows: 30,
      name: "xterm-256color",
    });
    this.#pty.onData((data) => options.onData(data.slice(0, 64_000)));
    this.#closed = new Promise((resolve) =>
      this.#pty.onExit(({ exitCode }) => {
        this.#exited = true;
        options.onExit(exitCode);
        resolve();
      }),
    );
  }
  write(data: string): void {
    if (this.#exited) throw new Error("terminal has exited");
    if (data.length > 64_000) throw new Error("terminal input limit exceeded");
    this.#pty.write(data);
  }
  resize(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 500 ||
      rows < 5 ||
      rows > 200
    )
      throw new Error("invalid terminal dimensions");
    if (!this.#exited) this.#pty.resize(cols, rows);
  }
  stop(): Promise<void> {
    return (this.#stopping ??= this.#stop());
  }
  async #stop(): Promise<void> {
    if (this.#exited) return;
    const kill = (signal: string) => {
      try {
        if (process.platform === "win32") this.#pty.kill();
        else process.kill(-this.#pty.pid, signal);
      } catch {
        try {
          this.#pty.kill(signal);
        } catch {
          /* 以 exit 回调判定清理完成。 */
        }
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1500);
    try {
      await this.#closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
