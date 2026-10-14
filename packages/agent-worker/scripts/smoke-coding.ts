import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCodingProvider } from "../src/collaboration/pi-provider.ts";
import { ClaudeCodingProvider } from "../src/collaboration/claude-provider.ts";
import { CodexCodingProvider } from "../src/collaboration/codex-provider.ts";
import type { CodingProviderPort } from "../src/collaboration/provider.ts";

// 人工触发真实 CLI 冒烟，不进入离线单测；只使用合成文件，不读取产品/用户仓库。
const directory = await mkdtemp(join(tmpdir(), "semi-coding-smoke-"));
const selected = process.argv[2] ?? "pi";
const writing = process.argv.includes("--write");
const providers: Record<string, () => CodingProviderPort> = {
  pi: () => new PiCodingProvider(),
  claude: () => new ClaudeCodingProvider(),
  codex: () => new CodexCodingProvider(),
};
if (!providers[selected]) throw new Error("Choose pi, claude or codex");
const provider = providers[selected]();
let permissions = 0;
let activities = 0;
let session = false;
let resolve!: (result: string) => void;
const outcome = new Promise<string>((done) => {
  resolve = done;
});
const timeout = setTimeout(() => resolve("timeout"), 120_000);
try {
  await writeFile(join(directory, "fixture.txt"), "SEMI_SMOKE_42\n");
  provider.start({
    cwd: directory,
    writing,
    prompt: writing
      ? "Replace SEMI_SMOKE_42 in fixture.txt with SEMI_SMOKE_43 using your file edit/patch tool. You may read it with cat fixture.txt. Change only this file in the current directory, never run other shell commands or access elsewhere. Answer exactly SEMI_SMOKE_43 when the write has succeeded."
      : selected === "codex"
        ? "Execute exactly cat fixture.txt in the current directory to read the file. Do not run other commands, write files, or read elsewhere. Answer exactly the token from the file."
        : "Use your read tool to read fixture.txt in the current directory. Do not run shell commands, write files, or read elsewhere. Answer exactly the token from the file.",
    permission: async (request) => {
      permissions++;
      // Codex 没有独立 read 工具；仅放行这个合成文件的精确只读命令。
      const safeRead =
        request.tool === "bash" &&
        request.input.cwd === directory &&
        typeof request.input.command === "string" &&
        (/^(?:cat|\/bin\/cat) (?:\.\/)?fixture\.txt$/.test(request.input.command.trim()) ||
          /^\/bin\/(?:zsh|bash|sh) -lc ['"](?:cat|\/bin\/cat) (?:\.\/)?fixture\.txt['"]$/.test(
            request.input.command.trim(),
          ));
      const allowed =
        ["read", "Read", "Grep", "Glob", "grep", "find", "ls"].includes(request.tool) ||
        safeRead ||
        (writing && ["edit", "Edit", "write", "Write", "file_change"].includes(request.tool));
      if (!allowed)
        console.log(
          JSON.stringify({
            provider: selected,
            deniedTool: request.tool,
            inputKeys: Object.keys(request.input),
            commandType: typeof request.input.command,
          }),
        );
      return allowed;
    },
    emit(event) {
      if (event.kind === "session") session = true;
      if (event.kind === "activity") activities++;
      if (event.kind === "completed")
        resolve(
          event.summary.includes(writing ? "SEMI_SMOKE_43" : "SEMI_SMOKE_42")
            ? "passed"
            : "wrong_result",
        );
      if (event.kind === "failed") {
        // Adapter 已归一化的固定错误可用于验收诊断，原始 CLI payload 不输出。
        console.log(JSON.stringify({ provider: selected, failure: event.message }));
        resolve("provider_failed");
      }
    },
  });
  let result = await outcome;
  const actual = await readFile(join(directory, "fixture.txt"), "utf8");
  if (result === "passed" && actual !== `${writing ? "SEMI_SMOKE_43" : "SEMI_SMOKE_42"}\n`)
    result = "file_mismatch";
  // 模型答对暗号不证明读取过文件；必须观察到真实工具活动。
  if (result === "passed" && !writing && activities === 0) result = "read_not_observed";
  if (result === "passed" && writing && permissions === 0) result = "permission_not_observed";
  console.log(JSON.stringify({ provider: selected, result, permissions, activities, session }));
  if (result !== "passed") process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await provider.stop();
  await rm(directory, { recursive: true, force: true });
}
