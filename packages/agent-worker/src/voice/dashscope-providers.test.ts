import assert from "node:assert/strict";
import test from "node:test";
import type { RawData } from "ws";
import { DashScopeSttProvider } from "./dashscope-stt.ts";
import { DashScopeTtsProvider } from "./dashscope-tts.ts";
import type { SttEvent } from "./stt.ts";
import type { TtsEvent } from "./tts.ts";
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
