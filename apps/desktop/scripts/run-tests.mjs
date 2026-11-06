import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = globSync("src/**/*.test.ts", { cwd: desktopRoot }).sort();

if (files.length === 0) {
  console.error("No desktop test files found under src/");
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
    cwd: desktopRoot,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
