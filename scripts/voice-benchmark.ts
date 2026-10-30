import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DashScopeTtsProvider } from "../packages/agent-worker/src/voice/dashscope-tts.ts";
import { DashScopeSttProvider } from "../packages/agent-worker/src/voice/dashscope-stt.ts";
import {
  characterErrors,
  percentile,
  wavePcm,
  normalizeTranscript,
} from "../packages/agent-worker/src/voice/benchmark.ts";

const samples = [
  "请打开浏览器，查找人工智能助手的长期记忆方案，比较三个来源并说明不同观点。",
  "在 Semi-OS 项目里调用 Pi、Codex 和 Claude Code，完成飞书登录页面并运行测试。",
  "帮我调研桌面语音助手的架构。先阅读官方文档，再比较浏览器自动化和原生桌面控制的优缺点，最后用简短语音汇报结论，完整报告里保留来源链接。如果某个网站需要登录，请告诉我，不要绕过访问限制。",
];
interface Sample {
  reference: string;
  pcm: Uint8Array;
  entities: string[];
  category: string;
}

async function humanSamples(manifest: string): Promise<Sample[]> {
  const path = resolve(manifest);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || value.length < 30) throw new Error("真人评测至少需要 30 条录音");
  const result: Sample[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.file !== "string" ||
      typeof item.reference !== "string" ||
      !item.reference.trim() ||
      typeof item.category !== "string" ||
      !Array.isArray(item.entities) ||
      item.entities.some((entity: unknown) => typeof entity !== "string" || !entity.trim())
    )
      throw new Error("invalid recording manifest");
    result.push({
      reference: item.reference,
      category: item.category,
      entities: item.entities,
      pcm: wavePcm(await readFile(resolve(dirname(path), item.file))),
    });
  }
  for (const category of ["中文", "英文工具名", "中英混合", "短句", "长指令", "数字路径"]) {
    if (!result.some((sample) => sample.category === category))
      throw new Error(`缺少分类：${category}`);
  }
  return result;
}

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  const voice = process.env.SEMI_OS_TTS_VOICE?.trim();
  const manifestIndex = process.argv.indexOf("--manifest");
  const manifest = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  if (manifestIndex >= 0 && !manifest) throw new Error("--manifest requires a path");
  if (!apiKey || (!manifest && !voice)) throw new Error("configure local .env first");
  const websocketUrl = process.env.SEMI_OS_DASHSCOPE_WEBSOCKET_URL;
  const directory = await mkdtemp(join(tmpdir(), "semi-os-voice-benchmark-"));
  const results = new Map<
    string,
    {
      errors: number;
      characters: number;
      entities: number;
      correct: number;
      failures: number;
      latency: number[];
    }
  >();
  try {
    const recordings = manifest ? await humanSamples(manifest) : [];
    if (!manifest)
      for (const [index, reference] of samples.entries()) {
        const synth = new DashScopeTtsProvider({
          apiKey,
          voice: voice!,
          websocketUrl,
          model: process.env.SEMI_OS_TTS_MODEL,
        });
        const chunks: Uint8Array[] = [];
        let timestamps = false;
        const started = performance.now();
        let firstAudioMs: number | undefined;
        for await (const event of synth.synthesize({
          sentenceId: `sample_${index}`,
          text: reference,
          signal: AbortSignal.timeout(60_000),
        })) {
          if (event.kind === "tts.audio") {
            firstAudioMs ??= performance.now() - started;
            chunks.push(event.data);
          }
          if (event.kind === "tts.timestamps") timestamps = true;
          if (event.kind === "tts.error") throw new Error(event.message);
        }
        const input = join(directory, `${index}.mp3`);
        const output = join(directory, `${index}.wav`);
        await writeFile(input, Buffer.concat(chunks));
        await promisify(execFile)("/usr/bin/afconvert", [
          input,
          output,
          "-f",
          "WAVE",
          "-d",
          "LEI16@16000",
          "-c",
          "1",
        ]);
        const pcm = wavePcm(await readFile(output));
        console.log(
          JSON.stringify({
            sample: index + 1,
            kind: "synthetic",
            durationMs: pcm.length / 32,
            ttsFirstAudioMs: Math.round(firstAudioMs ?? 0),
            timestamps,
          }),
        );
        recordings.push({
          reference,
          pcm,
          entities: ["Semi-OS", "Pi", "Codex", "Claude Code"].filter((entity) =>
            reference.includes(entity),
          ),
          category: "synthetic",
        });
      }
    for (const [index, { reference, pcm, entities, category }] of recordings.entries()) {
      for (const mode of ["qwen", "fun"] as const) {
        const provider = new DashScopeSttProvider({
          apiKey,
          websocketUrl,
          mode,
          model:
            mode === "qwen"
              ? process.env.SEMI_OS_STT_MODEL || "qwen-audio-3.1-asr-flash-streaming"
              : process.env.SEMI_OS_FUN_STT_MODEL || "fun-asr-realtime",
          nearfield: true,
          languageHints: ["zh", "en"],
          vocabulary: ["Semi-OS", "Pi", "Codex", "Claude Code", "飞书"],
          vocabularyId: mode === "fun" ? process.env.SEMI_OS_FUN_STT_VOCABULARY_ID : undefined,
        });
        let inputEnded = 0;
        let transcript = "";
        let failure: string | undefined;
        let finalizedAt: number | undefined;
        const begin = performance.now();
        const audio = (async function* () {
          let sequence = 0;
          for (let offset = 0; offset < pcm.length; offset += 3200) {
            yield {
              sequence: sequence++,
              data: pcm.subarray(offset, offset + 3200),
              mimeType: "audio/pcm",
              sampleRateHz: 16000,
            };
            await delay(pcm.subarray(offset, offset + 3200).length / 32);
          }
          inputEnded = performance.now();
        })();
        for await (const event of provider.transcribe({
          audio,
          signal: AbortSignal.timeout(90_000),
        })) {
          if (event.kind === "stt.final") {
            transcript = event.text;
            finalizedAt = performance.now();
          }
          if (event.kind === "stt.error") failure = event.message;
        }
        const quality = characterErrors(reference, transcript);
        const latency =
          inputEnded && finalizedAt !== undefined ? Math.max(0, finalizedAt - inputEnded) : null;
        const result = results.get(mode) ?? {
          errors: 0,
          characters: 0,
          entities: 0,
          correct: 0,
          failures: 0,
          latency: [],
        };
        result.errors += quality.errors;
        result.characters += quality.characters;
        result.entities += entities.length;
        result.correct += entities.filter((entity) =>
          normalizeTranscript(transcript).includes(normalizeTranscript(entity)),
        ).length;
        result.failures += failure || !transcript ? 1 : 0;
        if (latency !== null) result.latency.push(latency);
        results.set(mode, result);
        console.log(
          JSON.stringify({
            sample: index + 1,
            kind: manifest ? "human" : "synthetic",
            category,
            provider: mode,
            ...(process.argv.includes("--include-text") ? { reference, transcript } : {}),
            cer: quality.errors / Math.max(1, quality.characters),
            finalLatencyMs: latency,
            totalMs: Math.round(performance.now() - begin),
            failure,
          }),
        );
      }
    }
    for (const [provider, result] of results)
      console.log(
        JSON.stringify({
          kind: "aggregate",
          provider,
          samples: recordings.length,
          weightedCer: result.errors / Math.max(1, result.characters),
          entityAccuracy: result.entities ? result.correct / result.entities : null,
          failures: result.failures,
          finalP50Ms: percentile(result.latency, 0.5),
          finalP95Ms: percentile(result.latency, 0.95),
        }),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
