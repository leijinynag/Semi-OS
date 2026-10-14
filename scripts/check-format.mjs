import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const baselinePath = resolve(root, ".prettier-baseline");
const baseline = new Map(
  readFileSync(baselinePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64}) (.+)$/.exec(line);
      if (!match) throw new Error("Formatting baseline must contain content hashes");
      return [match[2], match[1]];
    }),
);

// 只豁免完全未变的历史内容；未跟踪文件也必须检查，不能等提交后才发现格式错误。
const candidates = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root },
)
  .toString()
  .split("\0")
  .filter((file) => file && existsSync(resolve(root, file)))
  .filter(
    (file) =>
      baseline.get(file) !==
      createHash("sha256")
        .update(readFileSync(resolve(root, file)))
        .digest("hex"),
  );

const qualityFiles = ["eslint.config.mjs", "package.json", "scripts/check-format.mjs"];
const managed = [...new Set([...candidates, ...qualityFiles])];

if (managed.length === 0) {
  console.log("Prettier baseline is clean; no newly managed files to check.");
  process.exit(0);
}

const prettierExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const existing = managed.filter((file) => {
  const extension = file.slice(file.lastIndexOf("."));
  return existsSync(resolve(root, file)) && prettierExtensions.has(extension);
});
if (existing.length) {
  execFileSync("pnpm", ["exec", "prettier", "--check", ...existing], {
    cwd: root,
    stdio: "inherit",
  });
}
