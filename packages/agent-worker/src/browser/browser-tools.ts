import { randomUUID } from "node:crypto";
import type { ResearchSource } from "@semi-os/protocol";
import type { JsonObject, ToolDefinition, ToolExecutionResult } from "@semi-os/tool-sdk";
import {
  BrowserOperationTimeout,
  BrowserService,
  navigationRisk,
  type BrowserObservation,
} from "./browser-service.ts";

export interface ResearchSink {
  save(source: ResearchSource, signal: AbortSignal): Promise<void>;
}
function string(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value || value.length > 20_000)
    throw new Error(`invalid ${key}`);
  return value;
}
function integer(input: JsonObject, key: string, fallback?: number): number {
  const value = input[key] ?? fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${key}`);
  return Number(value);
}
const property = { type: "string", minLength: 1 };
const identity = { pageId: property, version: { type: "integer", minimum: 1 }, ref: property };
function schema(properties: JsonObject, required: string[]): JsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}
const readContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: false, freshness: "best_effort" },
  mutation: { kind: "none", atomic: true },
  verification: { required: true, method: "tool" },
  reversibility: "reversible",
  idempotency: "idempotent",
  reconciliation: "safe",
};
const browserMutationContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: true, freshness: "fresh" },
  mutation: { kind: "external", atomic: true },
  verification: { required: true, method: "tool" },
  reversibility: "partially_reversible",
  idempotency: "non_idempotent",
  // 页面观察可以确认页面状态，但不能可靠证明外部提交是否已生效。
  reconciliation: "unsupported",
};
function observed(observation: BrowserObservation): ToolExecutionResult {
  return {
    output: { ...observation },
    outputSummary: `页面：${observation.title}（${observation.status}）`,
    resultType:
      observation.status === "ready"
        ? undefined
        : observation.status === "needs_user"
          ? "needs_user"
          : "failure",
  };
}

/** 四个工具只负责动作和来源采集；搜集哪些页面、比较什么仍由 Pi + Skill 决定。 */
export function createBrowserTools(browser: BrowserService, sink: ResearchSink): ToolDefinition[] {
  const verify: ToolDefinition["verify"] = async (_input, result) => {
    const pageId = result.output.pageId;
    const status = result.output.status;
    return {
      status: status === "ready" ? "passed" : "inconclusive",
      method: "browser_observation_readback",
      summary:
        status === "ready"
          ? "实际页面观察已返回；不代表页面事实正确"
          : String(result.output.reason ?? "页面需要用户处理"),
      evidence: [{ kind: "browser_page", reference: String(pageId) }],
    };
  };
  const recordFailure = async (
    observation: BrowserObservation,
    taskId: string,
    signal: AbortSignal,
  ) => {
    if (observation.status === "ready") return;
    await sink.save(
      {
        sourceId: `source_${randomUUID().replaceAll("-", "")}`,
        taskId,
        originalUrl: observation.originalUrl,
        finalUrl: observation.url,
        title: observation.title || observation.originalUrl,
        collectedAtMs: Date.now(),
        status: observation.status === "needs_user" ? "needs_user" : "failed",
        reason: observation.reason,
        quotes: [],
      },
      signal,
    );
  };
  return [
    {
      name: "browser_open",
      description: "打开 HTTP(S) 页面，返回页面身份、观察版本和元素引用；不返回全文。",
      riskLevel: "read",
      requiredCapabilities: ["browser"],
      contract: readContract,
      resolveRisk: async (input) => navigationRisk(string(input, "url")),
      inputSchema: schema({ url: property }, ["url"]),
      execute: async (input, context) => {
        const observation = await browser.open(string(input, "url"), context.signal);
        await recordFailure(observation, context.taskId, context.signal);
        return observed(observation);
      },
      verify,
    },
    ...(["browser_click", "browser_type"] as const).map((name): ToolDefinition => ({
      name,
      description:
        name === "browser_click"
          ? "点击当前观察中唯一的语义元素。必须携带 pageId/version/ref；动作后重新观察。"
          : "填入明确输入框，不按 Enter、不提交；提交必须独立点击。",
      riskLevel: "external_side_effect",
      requiredCapabilities: ["browser"],
      contract: browserMutationContract,
      inputSchema: schema(
        name === "browser_type" ? { ...identity, text: property } : identity,
        name === "browser_type"
          ? ["pageId", "version", "ref", "text"]
          : ["pageId", "version", "ref"],
      ),
      resolveRisk: (input, signal) =>
        browser.risk(
          string(input, "pageId"),
          integer(input, "version"),
          string(input, "ref"),
          name === "browser_type",
          signal ?? new AbortController().signal,
        ),
      execute: async (input, context) => {
        const observation = await browser.act(
          string(input, "pageId"),
          integer(input, "version"),
          string(input, "ref"),
          name === "browser_type" ? string(input, "text") : undefined,
          context.signal,
        );
        await recordFailure(observation, context.taskId, context.signal);
        return observed(observation);
      },
      verify,
    })),
    {
      name: "browser_extract",
      description:
        "刷新观察；渐进读取正文（offset/limit，最多 6000 字）或明确命名的 region。persist=false 只刷新观察。引用来自本次采集正文，不是搜索摘要。",
      riskLevel: "read",
      requiredCapabilities: ["browser"],
      contract: readContract,
      inputSchema: schema(
        {
          pageId: property,
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 6000 },
          region: property,
          persist: { type: "boolean" },
        },
        ["pageId"],
      ),
      execute: async (input, context) => {
        try {
          const id = string(input, "pageId");
          const initial = await browser.observe(id, context.signal);
          if (initial.status !== "ready") {
            await recordFailure(initial, context.taskId, context.signal);
            return observed(initial);
          }
          if (input.persist === false) return observed(initial);
          const offset = integer(input, "offset", 0);
          const limit = integer(input, "limit", 4000);
          if (limit < 1 || limit > 6000) throw new Error("limit must be 1..6000");
          const extracted = await browser.extract(
            id,
            offset,
            limit,
            context.signal,
            input.region === undefined ? undefined : string(input, "region"),
          );
          const observation = extracted.observation;
          if (observation.status !== "ready") {
            await recordFailure(observation, context.taskId, context.signal);
            return observed(observation);
          }
          if (offset >= extracted.text.length) throw new Error("正文为空或 offset 超出正文");
          if (extracted.text.length > 1_000_000) throw new Error("正文过长，需限定 region");
          const sourceId = `source_${randomUUID().replaceAll("-", "")}`;
          const artifactId = `artifact_${randomUUID().replaceAll("-", "")}`;
          const quoteId = `${sourceId}_q${offset}`;
          const source: ResearchSource = {
            sourceId,
            taskId: context.taskId,
            originalUrl: extracted.observation.originalUrl,
            finalUrl: extracted.observation.url,
            title: extracted.observation.title || extracted.observation.url,
            collectedAtMs: Date.now(),
            status: "collected",
            artifactId,
            digest: extracted.digest,
            text: extracted.text,
            quotes: [
              { quoteId, start: offset, end: extracted.nextOffset, text: extracted.segment },
            ],
            excerpt: extracted.segment.slice(0, 300),
          };
          await sink.save(source, context.signal);
          return {
            output: {
              ...extracted.observation,
              sourceId,
              artifactId,
              digest: extracted.digest,
              quoteId,
              text: extracted.segment,
              offset,
              nextOffset: extracted.nextOffset,
              truncated: extracted.truncated,
            },
            outputSummary: `已读取 ${source.title}，${extracted.segment.length} 字${extracted.truncated ? "（仍有未读内容）" : ""}`,
            artifacts: [
              {
                artifactId,
                kind: "research_body",
                uri: `artifact:${artifactId}`,
                digest: extracted.digest,
              },
            ],
          };
        } catch (error) {
          context.signal.throwIfAborted();
          if (!(error instanceof BrowserOperationTimeout)) throw error;
          await recordFailure(error.observation, context.taskId, context.signal);
          return observed(error.observation);
        }
      },
      verify,
    },
  ];
}
