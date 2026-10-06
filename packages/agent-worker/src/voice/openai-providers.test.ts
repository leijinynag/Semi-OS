import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiSttProvider } from "./openai-stt.ts";
import { OpenAiTtsProvider } from "./openai-tts.ts";

test("normalizes streamed STT events from an OpenAI-compatible response", async () => {
  const body = [
    'event: transcript.text.delta\ndata: {"delta":"你好"}\n\n',
    'event: transcript.text.delta\ndata: {"delta":"世界"}\n\n',
    'event: transcript.text.done\ndata: {"text":"你好世界"}\n\n',
  ].join("");
  const provider = new OpenAiSttProvider({
    apiKey: "test",
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const events = [];
  for await (const event of provider.transcribe({
    audio: (async function* () {
      yield {
        sequence: 0,
        data: new Uint8Array([1]),
        mimeType: "audio/webm",
      };
    })(),
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  assert.deepEqual(events.at(-1), { kind: "stt.final", text: "你好世界" });
});

test("streams TTS bytes with explicit first-audio and completion events", async () => {
  const provider = new OpenAiTtsProvider({
    apiKey: "test",
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
  });
  const events = [];
  for await (const event of provider.synthesize({
    sentenceId: "sentence_1",
    text: "你好",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  assert.equal(events[0]?.kind, "tts.first_audio_ready");
  assert.equal(events[1]?.kind, "tts.audio");
  assert.equal(events.at(-1)?.kind, "tts.completed");
});

test("normalizes cloud provider failures without leaking authorization", async () => {
  const provider = new OpenAiSttProvider({
    apiKey: "secret-token",
    fetch: async () =>
      new Response(
        '{"error":"Incorrect API key provided: secret-token; transcript: private speech"}',
        { status: 503 },
      ),
  });
  const events = [];
  for await (const event of provider.transcribe({
    audio: (async function* () {
      yield {
        sequence: 0,
        data: new Uint8Array([1]),
        mimeType: "audio/webm",
      };
    })(),
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.kind, "stt.error");
  assert.doesNotMatch(JSON.stringify(events), /secret-token/);
  assert.doesNotMatch(JSON.stringify(events), /private speech/);
});

test("cancels TTS through the caller AbortSignal", async () => {
  const controller = new AbortController();
  const provider = new OpenAiTtsProvider({
    apiKey: "test",
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
        controller.abort(new Error("user interrupted"));
      }),
  });
  const events = [];
  for await (const event of provider.synthesize({
    sentenceId: "sentence_cancelled",
    text: "不会播放",
    signal: controller.signal,
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { kind: "tts.cancelled", sentenceId: "sentence_cancelled" },
  ]);
});
