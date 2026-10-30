import type { ResearchReport } from "@semi-os/protocol";

/** 只取最终回答的一句；内部过程、代码和引用标识不进入兜底播报。 */
export function fallbackSpeech(finalText: string): string {
  const text = finalText
    .replace(/<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*(?:source_|quote_)[^\]]*\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[*_`]/g, "")
    .trim();
  // 没有标点时仍取有限前缀，避免“有文字但无 speech 标记”再次退化成无声。
  return text.match(/^.{1,160}?[。！？!?]/u)?.[0] || text.slice(0, 160);
}

/** 内部过程、口头摘要、详细报告在 Worker 分离，UI 不解析模型协议。 */
export function normalizeAnswer(
  text: string,
  explicitSpeech: boolean,
  report?: ResearchReport,
  unmarkedFinal = "",
): {
  summary: string;
  report: string;
} {
  const clean = (value: string) =>
    value
      .replace(/<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi, "")
      .replace(/```research-report[\s\S]*?(?:```|$)/g, "")
      .replace(/<\/?speech>/g, "")
      .trim();
  const speech = /<speech>([\s\S]*?)(?:<\/speech>|$)/.exec(text);
  const summary = clean(speech?.[1] ?? report?.summary ?? (explicitSpeech ? "" : text));
  // 只有明确位于口头段之后的文字才是报告；工具前的模型过程不能冒充用户答案。
  const boundary = text.indexOf("</speech>");
  const detailed = clean(
    boundary >= 0 ? text.slice(boundary + 9) : explicitSpeech ? unmarkedFinal : "",
  );
  const markdown =
    detailed ||
    (report
      ? [
          `## 结论\n${report.summary}`,
          ...report.claims.map((claim) => `- ${claim.text}`),
          ...(report.limitations.length
            ? ["\n## 局限", ...report.limitations.map((line) => `- ${line}`)]
            : []),
        ].join("\n")
      : "");
  return { summary, report: markdown };
}
