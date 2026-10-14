import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0 的 Unix 预编译包可能丢失 helper 的执行位。
// 安装时只修复当前平台的官方二进制，不下载替代程序、不更改依赖内容。
if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve("node-pty/package.json"));
  for (const folder of [
    "build/Release",
    "build/Debug",
    `prebuilds/${process.platform}-${process.arch}`,
  ]) {
    const helper = join(directory, folder, "spawn-helper");
    const info = await stat(helper).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isFile()) await chmod(helper, info.mode | 0o111);
  }
}
