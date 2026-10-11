import assert from "node:assert/strict";
import test from "node:test";
import { floatToPcm16, resampleMono, StreamingResampler, PcmRecorder } from "./pcm-recorder.ts";

test("resamples browser audio to the requested sample count", () => {
  const input = new Float32Array(4_800).fill(0.25);
  const output = resampleMono(input, 48_000, 16_000);

  assert.equal(output.length, 1_600);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.0001));
});

test("44.1 kHz resampling is invariant to chunk boundaries and flushes the tail", () => {
  const samples = Float32Array.from({ length: 4411 }, (_, index) => Math.sin(index / 40));
  const whole = new StreamingResampler(44_100, 16_000);
  const expected = [...whole.push(samples), ...whole.flush()];
  const streaming = new StreamingResampler(44_100, 16_000);
  const actual: number[] = [];
  for (let index = 0; index < samples.length; index += 128) actual.push(...streaming.push(samples.subarray(index, index + 128)));
  actual.push(...streaming.flush());
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 1601);
  assert.equal(streaming.flush().length, 0);
});

test("serializes normalized samples as little-endian PCM16", () => {
  const output = floatToPcm16(new Float32Array([-1, 0, 1]));
  const view = new DataView(output.buffer);

  assert.equal(view.getInt16(0, true), -32_768);
  assert.equal(view.getInt16(2, true), 0);
  assert.equal(view.getInt16(4, true), 32_767);
});

test("preloads worklet once, preserves short recordings and reuses context across turns", async (t) => {
  let modules = 0;
  let closes = 0;
  let processor!: {
    port: { onmessage?: (event: { data: unknown }) => void; postMessage(value: { kind: string; token: number }): void };
  };
  class Context {
    sampleRate = 48_000;
    state = "running";
    destination = {};
    audioWorklet = { async addModule() { modules++; } };
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { closes++; }
  }
  class Processor {
    port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (value: { kind: string; token: number }) => {
        if (value.kind === "end") this.port.onmessage?.({ data: { kind: "flushed", token: value.token } });
      },
      close() {},
    };
    constructor() { processor = this; }
    connect() {}
    disconnect() {}
  }
  // Node 没有音频设备；只替换 WebAudio 边界，不伪装真人采集验收。
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalProcessor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: Processor });
  t.after(() => {
    if (originalContext) Object.defineProperty(globalThis, "AudioContext", originalContext);
    else Reflect.deleteProperty(globalThis, "AudioContext");
    if (originalProcessor) Object.defineProperty(globalThis, "AudioWorkletNode", originalProcessor);
    else Reflect.deleteProperty(globalThis, "AudioWorkletNode");
  });
  const chunks: Uint8Array[] = [];
  const recorder = new PcmRecorder({ onChunk: (chunk) => chunks.push(chunk) });
  await recorder.prepare();
  await recorder.prepare();
  const stream = {} as MediaStream;
  for (let turn = 0; turn < 2; turn++) {
    await recorder.start(stream, turn + 1);
    processor.port.onmessage?.({ data: { kind: "samples", token: turn + 1, samples: new Float32Array(480).fill(0.5) } });
    await recorder.stop();
  }
  assert.equal(modules, 1);
  assert.equal(closes, 0);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [320, 320]);
  await recorder.dispose();
  assert.equal(closes, 1);
  const shared = new Context();
  const borrower = new PcmRecorder({ audioContext: shared as unknown as AudioContext, onChunk() {} });
  await borrower.prepare();
  await borrower.start({} as MediaStream);
  await borrower.stop();
  await borrower.dispose();
  assert.equal(closes, 1, "borrowed playback context must stay open");
});

test("late worklet messages after a flush timeout cannot enter the next recording", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const processors: Processor[] = [];
  class Processor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage() {},
      close() {},
    };
    constructor() { processors.push(this); }
    connect() {}
    disconnect() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: Processor });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "AudioWorkletNode", original);
    else Reflect.deleteProperty(globalThis, "AudioWorkletNode");
  });
  const context = {
    sampleRate: 48_000, state: "running", destination: {},
    audioWorklet: { async addModule() {} }, async resume() {},
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
  } as unknown as AudioContext;
  const chunks: Uint8Array[] = [];
  const recorder = new PcmRecorder({ audioContext: context, onChunk: (chunk) => chunks.push(chunk) });
  const stream = {} as MediaStream;
  await recorder.start(stream, 1);
  const staleHandler = processors[0]!.port.onmessage!;
  const stop = recorder.stop();
  t.mock.timers.tick(301);
  await stop;
  await recorder.start(stream, 2);
  assert.equal(processors.length, 1, "persistent processor is reused");
  staleHandler({ data: { kind: "samples", token: 1, samples: new Float32Array(4800).fill(0.5) } });
  assert.equal(chunks.length, 0, "expired processor must not feed the new resampler");
  let stopped = false;
  const nextStop = recorder.stop().then(() => { stopped = true; });
  staleHandler({ data: { kind: "flushed", token: 1 } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopped, false, "old flush must not acknowledge a new stop");
  processors[0]!.port.onmessage?.({ data: { kind: "flushed", token: 2 } });
  await nextStop;
  recorder.detach();
  assert.equal(processors[0]!.port.onmessage, null);
});
