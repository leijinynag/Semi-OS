import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const requiredScripts = ["lint", "format:check", "typecheck", "test", "build"];

/** 用 pnpm 的真实 workspace 清单预检，避免递归命令静默跳过缺少脚本的包。 */
export function validateWorkspaceScripts(manifests) {
  if (manifests.length === 0) return ["No child workspaces discovered"];
  return manifests.flatMap(({ name, scripts }) =>
    requiredScripts
      .filter((command) => typeof scripts?.[command] !== "string" || !scripts[command].trim())
      .map((command) => `${name}: missing required script "${command}"`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, "..");
  const workspaces = JSON.parse(
    execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  ).filter((workspace) => resolve(workspace.path) !== root);
  const errors = validateWorkspaceScripts(
    workspaces.map((workspace) =>
      JSON.parse(readFileSync(resolve(workspace.path, "package.json"), "utf8")),
    ),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Quality scripts verified for ${workspaces.length} workspaces.`);
  }
}
