import type { CapabilityStatus, ToolRiskLevel } from "@semi-os/shared";
import type { ToolDefinition } from "./tool.js";

export interface CapabilitySnapshot {
  key: string;
  status: CapabilityStatus;
  reason?: string;
  details?: Readonly<Record<string, unknown>>;
  observedAtMs: number;
}

export interface ToolActivationContext {
  platform: NodeJS.Platform;
  capabilities: ReadonlyMap<string, CapabilitySnapshot>;
  disabledTools?: ReadonlySet<string>;
  allowedRiskLevels?: ReadonlySet<ToolRiskLevel>;
  workspaceAvailable: boolean;
  runtimeHealthy: boolean;
  requiredBySkills?: ReadonlySet<string>;
}

export interface ToolAvailability {
  tool: ToolDefinition;
  active: boolean;
  reasons: readonly string[];
}

/**
 * Worker 进程内的工具目录。
 *
 * 注册和激活是两步：注册表示代码存在，激活表示当前平台、权限、策略和运行
 * 状态允许把它交给 Agent。Runtime 只能看到 `activeTools()` 的结果。
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  registerAll(tools: readonly ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }

  evaluate(context: ToolActivationContext): readonly ToolAvailability[] {
    return this.list().map((tool) => {
      const reasons: string[] = [];
      if (
        tool.supportedPlatforms &&
        !tool.supportedPlatforms.includes(context.platform)
      ) {
        reasons.push(`unsupported_platform:${context.platform}`);
      }
      for (const key of tool.requiredCapabilities) {
        const capability = context.capabilities.get(key);
        if (!capability || capability.status !== "available") {
          reasons.push(`capability_unavailable:${key}`);
        }
      }
      if (context.disabledTools?.has(tool.name)) {
        reasons.push("disabled_by_policy");
      }
      if (
        context.allowedRiskLevels &&
        !context.allowedRiskLevels.has(tool.riskLevel)
      ) {
        reasons.push(`risk_disallowed:${tool.riskLevel}`);
      }
      if (!context.runtimeHealthy) {
        reasons.push("runtime_unhealthy");
      }
      if (
        tool.riskLevel === "local_write" &&
        !context.workspaceAvailable
      ) {
        reasons.push("workspace_unavailable");
      }
      if (
        context.requiredBySkills &&
        context.requiredBySkills.size > 0 &&
        !context.requiredBySkills.has(tool.name)
      ) {
        reasons.push("not_required_by_active_skill");
      }
      return { tool, active: reasons.length === 0, reasons };
    });
  }

  activeTools(context: ToolActivationContext): readonly ToolDefinition[] {
    return this.evaluate(context)
      .filter((entry) => entry.active)
      .map((entry) => entry.tool);
  }
}
