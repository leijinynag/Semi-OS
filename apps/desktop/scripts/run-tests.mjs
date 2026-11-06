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
    const result = spawnSync(process.execPath, nodeArgsFor(file), {
      cwd: desktopRoot,
      stdio: "inherit",
    });
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

function nodeArgsFor(file) {
  const normalized = file.replaceAll("\\", "/");
  // Voice tests emit diagnostic objects; run them in-process so the test
  // runner never clones console payloads over a worker IPC channel.
  if (normalized.includes("/voice/")) {
    return ["--experimental-strip-types", file];
  }
  return ["--experimental-strip-types", "--test", ...isolationFlag, file];
}

function supportsTestIsolation() {
  const probe = spawnSync(process.execPath, ["--test", "--test-isolation=none", "--help"], {
    encoding: "utf8",
  });
  const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  return probe.status === 0 && text.includes("--test-isolation") && !text.includes("bad option");
}
