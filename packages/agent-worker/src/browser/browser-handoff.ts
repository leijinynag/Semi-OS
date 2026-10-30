import { randomUUID } from "node:crypto";
import type { EventPayloads } from "@semi-os/protocol";
import type { BrowserBackend } from "./browser-backend.ts";
import type { BrowserObservation } from "./browser-service.ts";
import type { BrowserUserWait } from "./browser-tools.ts";

export type BrowserSessionState = EventPayloads["browser.session.state"];
export interface BrowserTaskIdentity {
  sessionId: string;
  taskId: string;
}
interface PendingHandoff {
  state: BrowserSessionState;
  observation: BrowserObservation;
  signal: AbortSignal;
  resolve(value: BrowserObservation): void;
  reject(reason: unknown): void;
  cleanup(): void;
  operation?: AbortController;
}

/** 用户接管只挂起原工具调用。Pi 的原 Session/工具栈保持不变；
 * 一次性身份阻止旧按钮恢复新任务，取消不重放任何已派发动作。
 * 状态只在 Worker 生命周期内有效，重启后不自动认领用户 Space。
 */
export class BrowserHandoff {
  readonly #browser: BrowserBackend;
  readonly #current: () => BrowserTaskIdentity | undefined;
  readonly #emit: (state: BrowserSessionState) => void;
  #pending?: PendingHandoff;
  #state?: BrowserSessionState;

  constructor(
    browser: BrowserBackend,
    current: () => BrowserTaskIdentity | undefined,
    emit: (state: BrowserSessionState) => void,
  ) {
    this.#browser = browser;
    this.#current = current;
    this.#emit = emit;
  }

  snapshot(): BrowserSessionState | null {
    return this.#state ?? null;
  }

  wait(sessionId: string): BrowserUserWait {
    return async (observation, context) => {
      context.signal.throwIfAborted();
      if (!this.#browser.resume || this.#browser.supportsResume === false) return observation;
      const identity = { sessionId, taskId: context.taskId };
      if (!this.#matches(identity)) throw new Error("浏览器任务已经切换");
      if (this.#pending) throw new Error("已有浏览器接管正在等待用户");
      return new Promise<BrowserObservation>((resolve, reject) => {
        const cancel = () => this.cancel("浏览器任务已停止，未自动接管或重试");
        const pending: PendingHandoff = {
          state: {
            ...identity,
            resumeId: `resume_${randomUUID().replaceAll("-", "")}`,
            status: "waiting_user",
            message: observation.reason ?? "请在原 Ego Space 完成操作，再点击继续",
          },
          observation,
          signal: context.signal,
          resolve,
          reject,
          cleanup: () => context.signal.removeEventListener("abort", cancel),
        };
        this.#pending = pending;
        context.signal.addEventListener("abort", cancel, { once: true });
        this.#publish(pending, "waiting_user", pending.state.message);
      });
    };
  }

  /** 同步领取请求后返回 ACK；业务完成由独立事件表示，重复请求不产生第二次接管。 */
  resume(
    input: BrowserTaskIdentity & { resumeId: string; mode: "takeover" | "claim" },
  ): Promise<void> {
    const pending = this.#pending;
    if (
      !pending ||
      pending.state.resumeId !== input.resumeId ||
      pending.state.sessionId !== input.sessionId ||
      pending.state.taskId !== input.taskId ||
      !this.#matches(input)
    )
      throw new Error("接管请求已过期，请使用当前任务的继续按钮");
    if (pending.operation) throw new Error("浏览器正在恢复，请勿重复点击");
    pending.signal.throwIfAborted();
    const controller = new AbortController();
    pending.operation = controller;
    this.#publish(pending, "resuming", "正在恢复原 Ego Space 并重新观察");
    return this.#resume(pending, input.mode, controller);
  }

  cancel(message = "原任务已失效，未自动恢复浏览器"): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.cleanup();
    pending.operation?.abort();
    this.#publish(pending, "cancelled", message);
    pending.reject(new Error(message));
  }

  async #resume(
    pending: PendingHandoff,
    mode: "takeover" | "claim",
    controller: AbortController,
  ): Promise<void> {
    try {
      const observations = await this.#browser.resume!(
        mode,
        controller.signal,
        pending.observation.pageId,
      );
      if (this.#pending !== pending || !this.#matches(pending.state)) return;
      pending.signal.throwIfAborted();
      const current = observations.find((page) => page.pageId === pending.observation.pageId);
      if (!current) throw new Error("原页面不存在，请在原 Space 检查页面");
      if (observations.some((page) => page.status !== "ready")) {
        this.#publish(pending, "waiting_user", "原 Space 仍需要登录或验证，请处理后再次继续");
        return;
      }
      this.#pending = undefined;
      pending.cleanup();
      // resolve 返回的是新观察，不是上次动作。Pi 从原工具返回点自行决定下一步。
      this.#publish(pending, "resumed", "新观察已交回原任务，继续执行");
      pending.resolve(current);
    } catch {
      if (this.#pending === pending)
        this.#publish(
          pending,
          "failed",
          "未能恢复原 Space，请确认 Ego 中已交还控制；仅在需要时明确认领，未自动重试",
        );
    } finally {
      if (pending.operation === controller) pending.operation = undefined;
    }
  }

  #matches(identity: BrowserTaskIdentity): boolean {
    const current = this.#current();
    return current?.sessionId === identity.sessionId && current.taskId === identity.taskId;
  }

  #publish(pending: PendingHandoff, status: BrowserSessionState["status"], message: string): void {
    pending.state = { ...pending.state, status, message };
    this.#state = pending.state;
    this.#emit(pending.state);
  }
}
