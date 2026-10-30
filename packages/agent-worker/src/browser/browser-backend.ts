import type { BrowserObservation, BrowserService } from "./browser-service.ts";

/** 浏览器适配层保持同一工具契约；策略、来源持久化仍由现有工具与 Host 负责。 */
export type BrowserBackend = Pick<
  BrowserService,
  "open" | "observe" | "risk" | "policyEvidence" | "act" | "extract" | "dispose"
> & {
  readonly supportsResume?: boolean;
  /** 只恢复原 Space 并重新观察，禁止在这里重放导航、点击或输入。 */
  resume?(
    mode: "takeover" | "claim",
    signal: AbortSignal,
    pageId: string,
  ): Promise<BrowserObservation[]>;
};

/** 登录可能在风险检查或动作前出现，必须携带真实观察，不能当成普通 CLI 失败重试。 */
export class BrowserNeedsUser extends Error {
  readonly observation: BrowserObservation;
  constructor(observation: BrowserObservation) {
    super(observation.reason ?? "浏览器需要用户处理");
    this.observation = observation;
  }
}
