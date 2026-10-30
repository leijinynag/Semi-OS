import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type EgoRunner = (script: string, signal: AbortSignal) => Promise<unknown>;

/** CLI 不是 shell：只运行内置脚本，模型参数仅作为 JSON 数据嵌入。
 * 杀死 CLI 不代表浏览器动作已停止；调用者必须隔离结果不明的会话。
 */
export function createEgoRunner(
  executable: string,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
    commandArgs?: readonly string[];
  } = {},
): EgoRunner {
  return (script, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const marker = `SEMI_OS_EGO_${randomUUID()}:`;
      // 当前已安装 CLI 的 stdin 入口实际在非模块回调中求值，顶层 await
      // 会被当成未定义标识符；用受控异步函数承载脚本，避免正常操作被误判失败。
      // 这只是 Runner 的协议包装，不把任意脚本暴露给 Agent。
      const wrapped = `
;(async () => {
  try {
    const result = await (async () => { ${script}\n })();
    console.log(${JSON.stringify(marker)} + JSON.stringify({ok:true, result}));
  } catch (error) {
    console.log(${JSON.stringify(marker)} + JSON.stringify({
      ok:false, code: error?.code === "SEMI_OS_STALE" ? "stale" : "browser_error"
    }));
  }
})();`;
      // Windows 的 cmd shim 仅接收可信可执行路径；脚本通过 stdin，不进入命令行。
      const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
      if (shim && /[%"&|<>^!\r\n]/.test(executable)) {
        reject(new Error("Ego CLI 路径含不支持的命令字符，请配置原生可执行文件"));
        return;
      }
      const child = shim
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${executable}" nodejs"`], {
            windowsVerbatimArguments: true,
            windowsHide: true,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(executable, [...(options.commandArgs ?? ["nodejs"])], {
            windowsHide: true,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
      let output = "";
      let bytes = 0;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => stop(new Error("Ego 操作已取消；浏览器可能仍有迟到效果"));
      const timer = setTimeout(
        () => stop(new Error("Ego 操作超时；请检查原浏览器 Space，勿重复提交")),
        options.timeoutMs ?? 12_000,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (options.maxOutputBytes ?? 8_000_000))
            stop(new Error("Ego 输出超出限制，请缩小页面范围"));
          else output += decoder.write(chunk);
        });
        stream.on("end", () => {
          output += decoder.end();
        });
      }
      child.on("error", () => {
        failure ??= new Error("无法启动 Ego CLI，请完成 Ego Lite 安装与首次设置");
      });
      child.stdin.on("error", () => {
        failure ??= new Error("Ego CLI 输入通道关闭");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error("Ego CLI 执行失败，请检查浏览器连接和控制权"));
        try {
          const lines = output.split(/\r?\n/).filter((line) => line.startsWith(marker));
          if (lines.length !== 1) throw new Error("invalid envelope");
          const value: unknown = JSON.parse(lines[0]!.slice(marker.length));
          if (!value || typeof value !== "object" || !("ok" in value))
            throw new Error("invalid envelope");
          if (value.ok === false) {
            if ("code" in value && value.code === "stale") return reject(new EgoStaleObservation());
            return reject(new Error("Ego 操作未完成，请检查原 Space 的控制权、弹窗或页面状态"));
          }
          if (value.ok !== true || !("result" in value)) throw new Error("invalid envelope");
          resolve(value.result);
        } catch {
          reject(new Error("Ego CLI 返回了无效数据"));
        }
      });
      child.stdin.end(wrapped);
    });
}

export class EgoStaleObservation extends Error {
  constructor() {
    super("观察已过期，请重新 browser_extract");
  }
}
