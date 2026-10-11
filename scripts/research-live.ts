/**
 * 显式运行的付费验收，不进入默认单测：云 TTS 生成请求 -> 云 STT -> Pi ->
 * Playwright -> Rust Host SQLite -> 云 TTS。产物仅落入 Git 忽略的 output。
 * node --env-file=.env --experimental-strip-types scripts/research-live.ts
 */
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkerService } from "../packages/agent-worker/src/worker-service.ts";
import { DashScopeTtsProvider } from "../packages/agent-worker/src/voice/dashscope-tts.ts";
import type { Envelope, RequestId, JsonValue } from "../packages/protocol/src/index.ts";

const output = resolve("output", `research-live-${Date.now()}`);
await mkdir(output, { recursive: true });
const prompt = process.env.SEMI_OS_RESEARCH_PROMPT ?? "请使用浏览器阅读两个网站：Playwright 官网的介绍页 https://playwright.dev/ 和 Vitest 官网 https://vitest.dev/ 。对比两个工具的用途，各提取一个有原文引用的结论。先读取内置 research Skill，两个来源各只提取首段，不需要全文。最终用 speech 标记给简短语音结论，并输出 research-report 格式，不要执行 shell。";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240_000);
const tts = new DashScopeTtsProvider({
  apiKey: process.env.DASHSCOPE_API_KEY ?? "", voice: process.env.SEMI_OS_TTS_VOICE ?? "",
  model: process.env.SEMI_OS_TTS_MODEL, websocketUrl: process.env.SEMI_OS_DASHSCOPE_WEBSOCKET_URL,
});
const spoken: Uint8Array[] = [];
for await (const event of tts.synthesize({ sentenceId: "input", text: prompt, signal: controller.signal })) {
  if (event.kind === "tts.audio") spoken.push(event.data);
  if (event.kind === "tts.error") throw new Error(event.message);
}
if (!spoken.length) throw new Error("input speech generation failed");
await writeFile(`${output}/input.mp3`, Buffer.concat(spoken));
execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", `${output}/input.mp3`, `${output}/input.wav`]);
const wave = await readFile(`${output}/input.wav`);
let pcm: Buffer | undefined;
for (let offset = 12; offset + 8 <= wave.length;) {
  const length = wave.readUInt32LE(offset + 4);
  if (wave.toString("ascii", offset, offset + 4) === "data") { pcm = wave.subarray(offset + 8, offset + 8 + length); break; }
  offset += 8 + length + (length % 2);
}
if (!pcm) throw new Error("missing PCM data");
execFileSync("cargo", ["build", "-p", "semi-os-host", "--example", "research_bridge"], { stdio: "inherit" });
const bridge = spawn(resolve("target/debug/examples/research_bridge"), [`${output}/evidence.sqlite`], { stdio: ["pipe", "pipe", "inherit"] });
let worker!: WorkerService;
let archive: unknown;
const lines = createInterface({ input: bridge.stdout });
lines.on("line", (line) => {
  const reply = JSON.parse(line) as Record<string, unknown>;
  if (reply.archive) archive = reply.archive;
  else if (typeof reply.operationId === "string") void worker.handle({
    direction: "request", protocolVersion: 1, requestId: reply.operationId as RequestId,
    kind: "research.persisted", payload: reply as JsonValue,
  });
});
const events: Envelope[] = [];
const audio = new Map<string, Buffer[]>();
let finish!: () => void;
let fail!: (error: Error) => void;
const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
controller.signal.addEventListener("abort", () => fail(new Error("live workflow timed out")), { once: true });
worker = new WorkerService({
  environment: { ...process.env, SEMI_OS_BROWSER_HEADLESS: "true", SEMI_OS_BROWSER_PROFILE_DIR: `${output}/profile` },
  emit(event) {
    events.push(event);
    const payload = event.payload as Record<string, unknown>;
    if (["research.persist", "research.progress", "research.receipt", "voice.turn.completed"].includes(event.kind)) bridge.stdin.write(JSON.stringify(event) + "\n");
    if (event.kind === "voice.audio.chunk") {
      const id = String(payload.sentenceId);
      const chunks = audio.get(id) ?? [];
      chunks.push(Buffer.from(String(payload.audioBase64), "base64"));
      audio.set(id, chunks);
    }
    if (event.kind === "voice.error") console.log("voice error:", payload.code, payload.message);
    if (event.kind === "voice.turn.completed") finish();
    if (event.kind === "research.timing") console.log("timing:", payload.stage, payload.durationMs);
  },
});
const requestId = "req_live_research" as RequestId;
const request = (kind: string, payload: JsonValue) => worker.handle({ direction: "request", protocolVersion: 1, requestId, kind, payload });
const started = Date.now();
try {
  await request("voice.turn.start", { sessionId: `session_live_${Date.now()}`, taskId: `task_live_${Date.now()}`, cwd: process.cwd(), mimeType: "audio/pcm", sampleRateHz: 16000 });
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += 32000) {
    await request("voice.audio.append", { sequence: sequence++, audioBase64: pcm.subarray(offset, offset + 32000).toString("base64") });
  }
  await request("voice.turn.commit", { lastSequence: sequence - 1 });
  await completed;
  bridge.stdin.write(JSON.stringify({ kind: "archive" }) + "\n");
  for await (const _ of (async function* () { while (!archive) { await new Promise((resolve) => setTimeout(resolve, 20)); yield undefined; } })()) controller.signal.throwIfAborted();
  await writeFile(`${output}/archive.json`, JSON.stringify(archive, null, 2));
  await writeFile(`${output}/events.json`, JSON.stringify(events.map((event) => {
    const payload = { ...(event.payload as Record<string, unknown>) };
    delete payload.audioBase64;
    return { ...event, payload };
  }), null, 2));
  for (const [id, chunks] of audio) await writeFile(`${output}/${id}.mp3`, Buffer.concat(chunks));
  const report = events.find((event) => event.kind === "research.report");
  const errors = events.filter((event) => event.kind === "voice.error");
  console.log(JSON.stringify({ output, durationMs: Date.now() - started, report: report?.payload, errors: errors.map((event) => event.payload), audioSentences: audio.size }, null, 2));
  if (!report || errors.length) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await worker.dispose();
  bridge.stdin.end();
  lines.close();
  bridge.kill();
}
