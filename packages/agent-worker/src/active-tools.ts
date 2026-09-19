import {
  type ToolActivationContext,
  type ToolAvailability,
  type ToolDefinition,
  ToolRegistry,
} from "@semi-os/tool-sdk";
import type { AgentRuntimeAdapter } from "./runtime.ts";

export interface ActiveToolSnapshot {
  tools: readonly ToolDefinition[];
  availability: readonly ToolAvailability[];
}

/**
 * 连接能力发现、策略上下文和 Agent Runtime 的唯一入口。
 *
 * Registry 决定“当前能否启用”，Runtime 只负责应用结果。这样权限变化、
 * Provider 降级或 Skill 切换都能复用同一套筛选规则，不会在 Pi 适配器里
 * 再藏一套产品策略。
 */
export class ActiveToolCoordinator {
  readonly #registry: ToolRegistry;
  readonly #runtime: AgentRuntimeAdapter;
  #snapshot?: ActiveToolSnapshot;

  constructor(registry: ToolRegistry, runtime: AgentRuntimeAdapter) {
    this.#registry = registry;
    this.#runtime = runtime;
  }

  preview(context: ToolActivationContext): ActiveToolSnapshot {
    const availability = this.#registry.evaluate(context);
    return {
      availability,
      tools: availability
        .filter((entry) => entry.active)
        .map((entry) => entry.tool),
    };
  }

  async apply(context: ToolActivationContext): Promise<ActiveToolSnapshot> {
    const snapshot = this.preview(context);
    await this.#runtime.replaceTools(snapshot.tools);
    this.#snapshot = snapshot;
    return snapshot;
  }

  current(): ActiveToolSnapshot | undefined {
    return this.#snapshot;
  }
}
