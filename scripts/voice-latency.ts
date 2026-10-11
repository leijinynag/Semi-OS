import { readFile } from "node:fs/promises";
import { percentile } from "../packages/agent-worker/src/voice/benchmark.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: node --experimental-strip-types scripts/voice-latency.ts <voice-timing.jsonl>");
const stages = new Map<string, Map<string, number>>();
for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
  const value = JSON.parse(line);
  if (value.category !== "voice_timing" || typeof value.message !== "string" ||
    typeof value.details?.requestId !== "string" || typeof value.details?.durationMs !== "number" ||
    !Number.isFinite(value.details.durationMs) || value.details.durationMs < 0) continue;
  const turns = stages.get(value.message) ?? new Map<string, number>();
  // 一个轮次每阶段取首次记录，迟到/重复消息不把同一轮次重复计数。
  if (!turns.has(value.details.requestId)) turns.set(value.details.requestId, value.details.durationMs);
  stages.set(value.message, turns);
}
for (const [stage, turns] of stages) {
  const values = [...turns.values()];
  console.log(JSON.stringify({ stage, samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }));
}
