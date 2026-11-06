import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = globSync("src/**/*.test.ts", { cwd: desktopRoot }).sort();
const maxAttempts = 3;

if (files.length === 0) {
  console.error("No desktop test files found under src/");
  process.exit(1);
}

const isolationFlag = supportsTestIsolation() ? ["--test-isolation=none"] : [];

for (const file of files) {
  let status = 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", ...isolationFlag, file],
      { cwd: desktopRoot, stdio: "inherit" },
    );
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    status = result.status ?? 1;
    if (status === 0) break;
    if (attempt < maxAttempts) {
      console.error(`Retrying ${file} (${attempt + 1}/${maxAttempts})`);
    }
  }
  if (status !== 0) {
    process.exit(status);
  }
}

function supportsTestIsolation() {
  const help = spawnSync(process.execPath, ["--test", "--help"], { encoding: "utf8" });
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  return text.includes("isolation");
}
