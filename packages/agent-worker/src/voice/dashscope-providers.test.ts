import assert from "node:assert/strict";
import test from "node:test";
import type { RawData } from "ws";
import { DashScopeSttProvider } from "./dashscope-stt.ts";
import { DashScopeTtsProvider } from "./dashscope-tts.ts";
import type { SttEvent } from "./stt.ts";
import type { TtsEvent } from "./tts.ts";
import { AudioInput } from "./audio-input.ts";
import type {
  ProviderWebSocket,
  ProviderWebSocketFactory,
} from "./dashscope-websocket.ts";

class FakeWebSocket implements ProviderWebSocket {
  readonly sent: Array<string | Uint8Array> = [];
  readonly #openListeners: Array<() => void> = [];
  readonly #messageListeners: Array<
    (data: RawData, isBinary: boolean) => void
  > = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #closeListeners: Array<() => void> = [];
  closed = false;

  on(event: "open", listener: () => void): this;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(
    event: "open" | "message" | "error" | "close",
    listener:
      | (() => void)
      | ((data: RawData, isBinary: boolean) => void)
      | ((error: Error) => void),
  ): this {
    if (event === "open") {
      this.#openListeners.push(listener as () => void);
    } else if (event === "message") {
      this.#messageListeners.push(
        listener as (data: RawData, isBinary: boolean) => void,
      );
    } else if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#closeListeners.push(listener as () => void);
    }
    return this;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.#openListeners.forEach((listener) => listener());
  }

  message(value: unknown): void {
    this.#messageListeners.forEach((listener) =>
      listener(Buffer.from(JSON.stringify(value)), false),
    );
  }

  binary(data: Uint8Array): void {
    this.#messageListeners.forEach((listener) =>
      listener(Buffer.from(data), true),
    );
  }
}

function fixture(): {
  socket: FakeWebSocket;
  factory: ProviderWebSocketFactory;
  headers: Record<string, string>;
} {
  const socket = new FakeWebSocket();
  const headers: Record<string, string> = {};
  return {
    socket,
    headers,
    factory: (_url, inputHeaders) => {
      Object.assign(headers, inputHeaders);
      queueMicrotask(() => socket.open());
      return socket;
    },
  };
}

function action(message: string | Uint8Array): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  return (
    JSON.parse(message) as { header?: { action?: string } }
  ).header?.action;
}

test("pre-cancelled speech providers do not create a connection", async () => {
  const controller = new AbortController();
  controller.abort();
  const createWebSocket: ProviderWebSocketFactory = () => { throw new Error("must not connect"); };
  const stt = new DashScopeSttProvider({ apiKey: "test", createWebSocket });
  const tts = new DashScopeTtsProvider({ apiKey: "test", voice: "test", createWebSocket });
  const audio = (async function* () {})();
  const input = [];
  for await (const event of stt.transcribe({ audio, signal: controller.signal })) input.push(event.kind);
  const output = [];
  for await (const event of tts.synthesize({ sentenceId: "s1", text: "你好", signal: controller.signal })) output.push(event.kind);
  assert.deepEqual(input, ["stt.cancelled"]);
  assert.deepEqual(output, ["tts.cancelled"]);
});

test("starts DashScope STT before sending ordered PCM and normalizes results", async () => {
  const { socket, factory, headers } = fixture();
  const provider = new DashScopeSttProvider({
    apiKey: "secret-token",
    createWebSocket: factory,
  });
  const events: SttEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.transcribe({
      audio: (async function* () {
        yield {
          sequence: 0,
          data: new Uint8Array([1, 2]),
          mimeType: "audio/pcm",
          sampleRateHz: 16_000,
        };
      })(),
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
  })();

  await tick();
  assert.equal(action(socket.sent[0]!), "run-task");
  assert.equal(headers.Authorization, "Bearer secret-token");
  socket.message({ header: { event: "task-started" } });
  await tick();
  assert.deepEqual([...socket.sent[1] as Uint8Array], [1, 2]);
  assert.equal(action(socket.sent[2]!), "finish-task");
  socket.message({
    header: { event: "result-generated" },
    payload: {
      output: { sentence: { text: "你好", sentence_end: false } },
    },
  });
  socket.message({
    header: { event: "result-generated" },
    payload: {
      output: { sentence: { text: "你好世界", sentence_end: true } },
    },
  });
  socket.message({ header: { event: "task-finished" } });
  await consume;

  assert.deepEqual(events, [
    { kind: "stt.partial", text: "你好" },
    { kind: "stt.partial", text: "你好世界" },
    { kind: "stt.final", text: "你好世界" },
  ]);
});

test("rejects non-PCM input without exposing the API key", async () => {
  const { socket, factory } = fixture();
  const provider = new DashScopeSttProvider({
    apiKey: "secret-token",
    createWebSocket: factory,
  });
  const events: SttEvent[] = [];
  const consume = (async () => {
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
  })();

  await tick();
  socket.message({ header: { event: "task-started" } });
  await consume;

  assert.equal(events.at(-1)?.kind, "stt.error");
  assert.doesNotMatch(JSON.stringify(events), /secret-token/);
});

test("streams CosyVoice binary frames and completes after task-finished", async () => {
  const { socket, factory } = fixture();
  const provider = new DashScopeTtsProvider({
    apiKey: "test",
    voice: "test-voice",
    createWebSocket: factory,
  });
  const events: TtsEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.synthesize({
      sentenceId: "sentence_1",
      text: "你好",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
  })();

  await tick();
  socket.message({ header: { event: "task-started" } });
  await tick();
  assert.deepEqual(
    socket.sent.slice(1, 3).map(action),
    ["continue-task", "finish-task"],
  );
  socket.binary(new Uint8Array([1, 2, 3]));
  socket.message({ header: { event: "task-finished" } });
  await consume;

  assert.equal(events[0]?.kind, "tts.first_audio_ready");
  assert.equal(events[1]?.kind, "tts.audio");
  assert.equal(events.at(-1)?.kind, "tts.completed");
});

test("cancels an active CosyVoice task without emitting late audio", async () => {
  const { socket, factory } = fixture();
  const controller = new AbortController();
  const provider = new DashScopeTtsProvider({
    apiKey: "test",
    voice: "test-voice",
    createWebSocket: factory,
  });
  const events: TtsEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.synthesize({
      sentenceId: "sentence_cancelled",
      text: "停止播放",
      signal: controller.signal,
    })) {
      events.push(event);
    }
  })();

  await tick();
  socket.message({ header: { event: "task-started" } });
  await tick();
  controller.abort(new Error("user interrupted"));
  await consume;

  const lastPayload = socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as {
      payload?: { input?: { directive?: string } };
    })
    .at(-1);
  assert.equal(lastPayload?.payload?.input?.directive, "cancel");
  assert.deepEqual(events, [
    { kind: "tts.cancelled", sentenceId: "sentence_cancelled" },
  ]);
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("prewarms only transport and claims the open connection once for the first sentence", async () => {
  const { socket, factory } = fixture();
  let connections = 0;
  const provider = new DashScopeTtsProvider({ apiKey: "test", voice: "test",
    createWebSocket: (url, headers) => { connections++; return factory(url, headers); } });
  const turn = new AbortController();
  provider.prepare(turn.signal);
  provider.prepare(turn.signal);
  await tick();
  assert.equal(connections, 1);
  assert.equal(socket.sent.length, 0, "preparation must not start billable synthesis");
  const events: TtsEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.synthesize({
      sentenceId: "prepared", text: "你好。", signal: new AbortController().signal,
    })) events.push(event);
  })();
  await tick();
  assert.equal(connections, 1);
  assert.equal(action(socket.sent[0]!), "run-task");
  turn.abort();
  assert.equal(socket.closed, false, "claimed connection belongs to synthesis cancellation");
  socket.message({ header: { event: "task-started" } });
  socket.binary(new Uint8Array([0, 1]));
  socket.message({ header: { event: "task-finished" } });
  await consume;
  assert.equal(events.at(-1)?.kind, "tts.completed");
  assert.equal(socket.closed, true);
});

test("cancelling prewarm releases transport and allows a fresh synthesis", async () => {
  const sockets: FakeWebSocket[] = [];
  const provider = new DashScopeTtsProvider({ apiKey: "test", voice: "test",
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    } });
  const turn = new AbortController();
  provider.prepare(turn.signal);
  await tick();
  turn.abort();
  assert.equal(sockets[0]!.closed, true);
  assert.equal(sockets[0]!.sent.length, 0);
  const consume = (async () => {
    for await (const _event of provider.synthesize({
      sentenceId: "fresh", text: "下一句。", signal: new AbortController().signal,
    })) { /* 消费到终态，验证取消的连接不被复用。 */ }
  })();
  await tick();
  assert.equal(sockets.length, 2);
  sockets[1]!.message({ header: { event: "task-started" } });
  sockets[1]!.message({ header: { event: "task-finished" } });
  await consume;
});

test("receives partial STT while input remains open, cancels the producer and separates Fun parameters", async () => {
  const { socket, factory } = fixture();
  const input = new AudioInput();
  const controller = new AbortController();
  const provider = new DashScopeSttProvider({ apiKey: "test", mode: "fun", nearfield: true,
    languageHints: ["zh"], vocabulary: ["Semi-OS"], vocabularyId: "vocab-test", createWebSocket: factory });
  const events: SttEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.transcribe({ audio: input, signal: controller.signal })) events.push(event);
  })();
  await tick();
  const run = JSON.parse(socket.sent[0] as string).payload;
  assert.equal(run.model, "fun-asr-realtime");
  assert.equal(run.parameters.max_sentence_silence, 800);
  assert.equal(run.parameters.vad_model, undefined);
  assert.equal(run.parameters.vocabulary, undefined);
  assert.equal(run.parameters.vocabulary_id, "vocab-test");
  socket.message({ header: { event: "task-started" } });
  input.push({ sequence: 0, data: new Uint8Array([0, 0]), mimeType: "audio/pcm", sampleRateHz: 16_000 });
  await tick();
  assert.equal(socket.sent.some((message) => action(message) === "finish-task"), false);
  socket.message({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "持续录音", sentence_end: false } } } });
  await tick();
  assert.deepEqual(events, [{ kind: "stt.partial", text: "持续录音" }]);
  controller.abort();
  await consume;
  input.close(true);
  assert.equal(events.at(-1)?.kind, "stt.cancelled");
  assert.equal(socket.closed, true);
});

test("Fun vocabulary failures are visible and never silently retry without hotwords", async () => {
  const { socket, factory } = fixture();
  const provider = new DashScopeSttProvider({ apiKey: "secret", mode: "fun", vocabularyId: "vocab-test", createWebSocket: factory });
  const events: SttEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.transcribe({ audio: (async function* () {})(), signal: new AbortController().signal })) events.push(event);
  })();
  await tick();
  socket.message({ header: { event: "task-failed", error_message: "secret" } });
  await consume;
  const error = events.find((event) => event.kind === "stt.error");
  assert.ok(error && error.kind === "stt.error");
  assert.match(error.message, /词表|热词|vocabulary/);
  assert.equal(error.message.includes("secret"), false);
  assert.equal(socket.sent.length, 1);
  assert.throws(() => new DashScopeSttProvider({ apiKey: "test", mode: "fun", vocabularyId: "../invalid" }));
});

test("requests CosyVoice timestamps and ignores malformed time ranges without blocking audio", async () => {
  const { socket, factory } = fixture();
  const provider = new DashScopeTtsProvider({ apiKey: "test", voice: "test", createWebSocket: factory });
  const events: TtsEvent[] = [];
  const consume = (async () => {
    for await (const event of provider.synthesize({ sentenceId: "s1", text: "你好", signal: new AbortController().signal })) events.push(event);
  })();
  await tick();
  assert.equal(JSON.parse(socket.sent[0] as string).payload.parameters.word_timestamp_enabled, true);
  socket.message({ header: { event: "task-started" } });
  socket.message({ header: { event: "result-generated" }, payload: { output: {
    type: "sentence-end", sentence: { words: [{ text: "你", begin_time: 100, end_time: 0 }] },
  } } });
  socket.binary(new Uint8Array([1, 2]));
  socket.message({ header: { event: "result-generated" }, payload: { output: {
    type: "sentence-end", sentence: { words: [
      { text: "你", begin_time: 0, end_time: 120 }, { text: "好", begin_time: 120, end_time: 240 },
    ] },
  } } });
  socket.message({ header: { event: "task-finished" } });
  await consume;
  assert.deepEqual(events.find((event) => event.kind === "tts.timestamps"), {
    kind: "tts.timestamps", sentenceId: "s1", words: [
      { text: "你", startMs: 0, endMs: 120 }, { text: "好", startMs: 120, endMs: 240 },
    ],
  });
  assert.equal(events.filter((event) => event.kind === "tts.timestamps").length, 1);
  assert.equal(events.at(-1)?.kind, "tts.completed");
});
