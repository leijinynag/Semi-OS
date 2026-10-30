import { ProtocolValidationError } from "./envelope.ts";

/** 页面采集证据与 Agent 结论分开；collected 只表示读取成功，不代表事实正确。 */
export interface ResearchSource {
  sourceId: string;
  taskId: string;
  originalUrl: string;
  finalUrl: string;
  title: string;
  collectedAtMs: number;
  status: "collected" | "needs_user" | "failed";
  reason?: string;
  artifactId?: string;
  digest?: string;
  excerpt?: string;
  text?: string;
  quotes: Array<{ quoteId: string; start: number; end: number; text: string }>;
}
export interface ResearchReport {
  taskId: string;
  summary: string;
  claims: Array<{ text: string; citations: Array<{ sourceId: string; quoteId: string }> }>;
  limitations: string[];
}
export function parseResearchSource(value: unknown): ResearchSource {
  if (!value || typeof value !== "object")
    throw new ProtocolValidationError("invalid source", "invalid_payload");
  const source = value as ResearchSource;
  for (const key of ["sourceId", "taskId", "originalUrl", "finalUrl", "title"] as const) {
    if (typeof source[key] !== "string" || !source[key])
      throw new ProtocolValidationError(`invalid source ${key}`, "invalid_payload");
  }
  if (
    !Number.isSafeInteger(source.collectedAtMs) ||
    !["collected", "failed", "needs_user"].includes(source.status) ||
    !Array.isArray(source.quotes)
  )
    throw new ProtocolValidationError("invalid source metadata", "invalid_payload");
  if (
    source.status === "collected" &&
    (typeof source.text !== "string" ||
      source.text.length > 1_000_000 ||
      !source.artifactId ||
      !source.digest)
  )
    throw new ProtocolValidationError("invalid source body", "invalid_payload");
  const ids = new Set<string>();
  for (const quote of source.quotes) {
    if (
      !quote ||
      typeof quote.quoteId !== "string" ||
      ids.has(quote.quoteId) ||
      !Number.isSafeInteger(quote.start) ||
      !Number.isSafeInteger(quote.end) ||
      quote.start < 0 ||
      quote.end <= quote.start ||
      source.text?.slice(quote.start, quote.end) !== quote.text
    )
      throw new ProtocolValidationError("invalid quote", "invalid_payload");
    ids.add(quote.quoteId);
  }
  return source;
}
