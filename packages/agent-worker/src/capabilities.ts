import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CapabilityStatus } from "@semi-os/shared";
import type { CapabilitySnapshot } from "@semi-os/tool-sdk";

export interface CapabilityProbe {
  key: string;
  observe(): Promise<Omit<CapabilitySnapshot, "key">>;
}

export interface CapabilityDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  commandExists?: (command: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

export interface CapabilityDiscoveryResult {
  snapshots: ReadonlyMap<string, CapabilitySnapshot>;
  observedAtMs: number;
}

async function defaultCommandExists(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const executableNames =
    process.platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`]
      : [command];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const executable of executableNames) {
      try {
        await access(join(directory, executable));
        return true;
      } catch {
        // PATH 中一个候选不存在很常见，继续检查剩余目录。
      }
    }
  }
  return false;
}

function snapshot(
  key: string,
  status: CapabilityStatus,
  observedAtMs: number,
  reason?: string,
  details?: Readonly<Record<string, unknown>>,
): CapabilitySnapshot {
  return { key, status, observedAtMs, reason, details };
}

/**
 * 探测 Worker 自己能观察到的非特权能力。
 *
 * macOS Accessibility、Screen Recording 等权限由 Rust Host 探测并传入，
 * Worker 不能凭环境变量或命令存在性自行授予这些能力。
 */
export async function discoverRuntimeCapabilities(
  options: CapabilityDiscoveryOptions = {},
): Promise<CapabilityDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const observedAtMs = now();
  const snapshots = new Map<string, CapabilitySnapshot>();

  snapshots.set(
    "platform.macos",
    snapshot(
      "platform.macos",
      platform === "darwin" ? "available" : "unavailable",
      observedAtMs,
      platform === "darwin" ? undefined : `current platform is ${platform}`,
    ),
  );

  for (const [key, command] of [
    ["browser.playwright", "playwright"],
    ["coding.pi", "pi"],
    ["coding.claude", "claude"],
    ["coding.codex", "codex"],
    ["cli.lark", "lark-cli"],
  ] as const) {
    const available = await commandExists(command, env);
    snapshots.set(
      key,
      snapshot(
        key,
        available ? "available" : "unavailable",
        observedAtMs,
        available ? undefined : `${command} was not found on PATH`,
        { command },
      ),
    );
  }

  return { snapshots, observedAtMs };
}

export async function runCapabilityProbes(
  probes: readonly CapabilityProbe[],
): Promise<ReadonlyMap<string, CapabilitySnapshot>> {
  const entries = await Promise.all(
    probes.map(async (probe) => {
      try {
        return [probe.key, { key: probe.key, ...(await probe.observe()) }] as const;
      } catch (error) {
        return [
          probe.key,
          {
            key: probe.key,
            status: "unknown" as const,
            reason: error instanceof Error ? error.message : String(error),
            observedAtMs: Date.now(),
          },
        ] as const;
      }
    }),
  );
  return new Map(entries);
}
