import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestOutput {
  exitCode: number;
  text: string;
}

/** shell 不暴露任意 cwd，调用方先核对工作区版本并经 Host 确认命令。
 * 输出限长、超时及取消均杀整个进程组；失败不会被归一化为 exit 0。
 */
export async function runTest(
  cwd: string,
  command: string,
  signal: AbortSignal,
  confined = false,
): Promise<TestOutput> {
  signal.throwIfAborted();
  let directory: string | undefined;
  let program = "/bin/sh";
  let args = ["-c", command];
  let env = process.env;
  if (confined) {
    if (process.platform !== "darwin") throw new Error("本平台没有已验证的测试沙箱");
    directory = await mkdtemp(join(tmpdir(), "semi-test-"));
    const root = await realpath(cwd);
    const temporary = await realpath(directory);
    // 不继承云端密钥；仅允许工作区、工具链/系统读取及独立临时目录写入，禁网络。
    const quote = (path: string) => JSON.stringify(path);
    const profile = [
      "(version 1) (deny default)",
      "(allow process*) (allow sysctl-read) (allow mach-lookup)",
      "(allow file-read-metadata)",
      // dyld 需要读取根目录本身；literal 不会开放用户目录下的文件内容。
      '(allow file-read* (literal "/"))',
      `(allow file-read* (subpath ${quote(root)}) (subpath ${quote(temporary)}) (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/opt/homebrew"))`,
      `(allow file-write* (subpath ${quote(root)}) (subpath ${quote(temporary)}) (literal "/dev/null"))`,
      '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath "/private/etc"))',
    ].join("\n");
    program = "/usr/bin/sandbox-exec";
    args = ["-p", profile, "/bin/sh", "-c", command];
    env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, LANG: process.env.LANG };
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        const kill = (kind: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
            else child.kill(kind);
          } catch {
            /* close determines lifecycle */
          }
        };
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, 120_000);
      const append = (chunk: Buffer) => {
        if (text.length < 24_000) text += chunk.toString("utf8").slice(0, 24_000 - text.length);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", () => stop());
      child.once("close", (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
        if (signal.aborted) {
          reject(new Error("测试已取消，输出未验收"));
          return;
        }
        // 防止常见凭证混入持久化结果；UI 不接收未处理的 stdout/stderr。
        text = text
          .replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{12,}\b/g, "[redacted]")
          .replace(/((?:authorization|api[_-]?key|token|password)\s*[:=]\s*)\S+/gi, "$1[redacted]");
        resolve({ exitCode: timedOut ? 124 : (code ?? 1), text: text || "无输出" });
      });
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
