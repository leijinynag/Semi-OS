import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "./provider.ts";

/** 受限子进程不加载用户工具规则，仅继承本机已配置的认证网关与模型。 */
export function claudeConfiguration(environment: NodeJS.ProcessEnv, value?: unknown) {
  let settings = value;
  if (settings === undefined) {
    try {
      settings = JSON.parse(
        readFileSync(
          join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
          "utf8",
        ),
      );
    } catch {
      settings = {};
    }
  }
  const config = record(settings);
  // 自动更新会在长任务中替换本机 CLI，固定运行生命周期内的可执行版本。
  const env: NodeJS.ProcessEnv = { ...environment, DISABLE_AUTOUPDATER: "1" };
  for (const [key, value] of Object.entries(record(config.env))) {
    if (
      /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_[A-Z_]+MODEL(?:_NAME)?)$/.test(key) &&
      typeof value === "string" &&
      !env[key]
    )
      env[key] = value;
  }
  return { env, model: typeof config.model === "string" ? config.model : undefined };
}
