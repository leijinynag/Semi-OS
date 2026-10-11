import assert from "node:assert/strict";
import test from "node:test";
import { PcmStream, type PcmPlayback } from "./pcm-stream.ts";
import { VoicePlayer, type PlaybackEvent } from "./voice-player.ts";
import { VOICE_PCM_MIME } from "@semi-os/protocol";

class AudioContextFixture {
  static instances: AudioContextFixture[] = [];
  currentTime = 0;
  state = "running";
  resumed = 0;
  closed = false;
  destination = {};
  readonly buffers: Float32Array[] = [];
  readonly sources: Array<{
    buffer?: { duration: number };
    onended: (() => void) | null;
    startAt?: number;
    stopped: boolean;
    connect(): void;
    disconnect(): void;
    start(at: number): void;
    stop(): void;
  }> = [];

  constructor() { AudioContextFixture.instances.push(this); }
  async resume() { this.state = "running"; this.resumed++; }
  async close() { this.closed = true; }

  createAnalyser() {
    return {
      fftSize: 256,
      connect() {},
      disconnect() {},
      getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.1); },
    };
  }

  createBuffer(_channels: number, count: number, sampleRate: number) {
    const channel = new Float32Array(count);
    this.buffers.push(channel);
    return { duration: count / sampleRate, getChannelData: () => channel };
  }

  createBufferSource() {
    const source = {
      buffer: undefined as { duration: number } | undefined,
      onended: null as (() => void) | null,
      startAt: undefined as number | undefined,
      stopped: false,
      connect() {},
      disconnect() {},
      start(at: number) { this.startAt = at; },
      stop() { this.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }
}

test("VoicePlayer resumes a suspended context when PCM arrives and after a later interruption", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const original = globalThis.AudioContext;
  Object.assign(globalThis, { AudioContext: AudioContextFixture });
  const events: PlaybackEvent[] = [];
  const player = new VoicePlayer((event) => events.push(event));
  try {
    await player.unlock();
    const audio = AudioContextFixture.instances.at(-1)!;
    audio.state = "suspended";
    player.append("resume", VOICE_PCM_MIME, Buffer.alloc(4410).toString("base64"), true);
    await Promise.resolve();
    assert.equal(audio.state, "running");
    assert.equal(audio.resumed, 2);
    audio.currentTime = 0.07;
    t.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "playing");
    audio.state = "interrupted";
    t.mock.timers.tick(20);
    await Promise.resolve();
    assert.equal(audio.resumed, 3);
    t.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "playing");
  } finally {
    player.dispose();
    Object.assign(globalThis, { AudioContext: original });
  }
});

test("VoicePlayer reports failed recovery and ignores recovery after cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const original = globalThis.AudioContext;
  Object.assign(globalThis, { AudioContext: AudioContextFixture });
  const events: PlaybackEvent[] = [];
  const player = new VoicePlayer((event) => events.push(event));
  try {
    await player.unlock();
    const audio = AudioContextFixture.instances.at(-1)!;
    audio.state = "suspended";
    audio.resume = async () => {};
    player.append("stalled", VOICE_PCM_MIME, Buffer.alloc(4410).toString("base64"), true);
    t.mock.timers.tick(3000);
    assert.equal(events.at(-1)!.state, "failed");
    assert.equal(player.busy, false);
    player.append("cancelled", VOICE_PCM_MIME, Buffer.alloc(4410).toString("base64"), true);
    player.stop();
    const count = events.length;
    t.mock.timers.tick(4000);
    await Promise.resolve();
    assert.equal(events.length, count);
    assert.equal(player.busy, false);
  } finally {
    player.dispose();
    Object.assign(globalThis, { AudioContext: original });
  }
});

test("PCM schedules immediately and keeps contiguous chunks without cross-fade", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const audio = new AudioContextFixture();
  const events: PcmPlayback[] = [];
  const level = { current: 0 };
  const stream = new PcmStream(audio as unknown as AudioContext, level, (event) => events.push(event));
  try {
    stream.append(new Uint8Array(4410)); // 100 ms，未 complete 也必须排程。
    stream.append(new Uint8Array(4410));
    assert.equal(audio.sources.length, 2);
    assert.equal(audio.sources[0]!.startAt, 0.02);
    assert.ok(Math.abs(audio.sources[1]!.startAt! - 0.12) < 1e-8);

    audio.currentTime = 0.07;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "playing");
    assert.equal(events.at(-1)!.positionMs, 50);
    assert.ok(level.current > 0);

    audio.currentTime = 0.3;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "buffering");
    assert.equal(events.at(-1)!.positionMs, 200);
    assert.equal(level.current, 0);
    // 已播放片段被清理后，欠载空隙不能算进新的文字进度。
    stream.append(new Uint8Array(4410));
    assert.equal(audio.sources[2]!.startAt, 0.32);
    stream.complete();
    assert.equal(events.some((event) => event.state === "ended"), false);
    audio.currentTime = 0.37;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.positionMs, 250);
    audio.currentTime = 0.5;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "ended");
    assert.equal(events.at(-1)!.positionMs, 300);
  } finally { stream.stop(); }
});

test("PCM preserves split samples and stops scheduled audio on interruption", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const audio = new AudioContextFixture();
  const events: PcmPlayback[] = [];
  const stream = new PcmStream(audio as unknown as AudioContext, { current: 0 }, (event) => events.push(event));
  try {
    stream.append(Uint8Array.of(0xff));
    assert.equal(audio.sources.length, 0);
    stream.append(Uint8Array.of(0x7f, 0x00, 0x80));
    assert.deepEqual([...audio.buffers[0]!], [32767 / 32768, -1]);
    stream.stop();
    assert.equal(audio.sources[0]!.stopped, true);
    stream.append(new Uint8Array(4410));
    stream.complete();
    audio.currentTime = 1;
    context.mock.timers.tick(20);
    assert.equal(audio.sources.length, 1);
    assert.equal(events.some((event) => event.state === "ended"), false);
  } finally { stream.stop(); }
});

test("PCM input with an incomplete sample fails instead of claiming playback ended", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const audio = new AudioContextFixture();
  const events: PcmPlayback[] = [];
  const stream = new PcmStream(audio as unknown as AudioContext, { current: 0 }, (event) => events.push(event));
  stream.append(Uint8Array.of(1));
  stream.complete();
  assert.equal(events.at(-1)!.state, "failed");
  assert.equal(events.some((event) => event.state === "ended"), false);
});

test("a running context with a frozen clock fails instead of buffering forever", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const audio = new AudioContextFixture();
  const events: PcmPlayback[] = [];
  const stream = new PcmStream(audio as unknown as AudioContext, { current: 0 }, (event) => events.push(event));
  try {
    stream.append(new Uint8Array(4410));
    stream.complete();
    now = 3001;
    t.mock.timers.tick(20);
    assert.equal(events.at(-1)?.state, "failed");
    assert.equal(events.some((event) => event.state === "ended"), false);
    assert.equal(audio.sources[0]!.stopped, true);
  } finally { stream.stop(); }
});

test("PCM pauses text progress with the audio context", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const audio = new AudioContextFixture();
  const events: PcmPlayback[] = [];
  const stream = new PcmStream(audio as unknown as AudioContext, { current: 0 }, (event) => events.push(event));
  try {
    stream.append(new Uint8Array(4410));
    audio.currentTime = 0.07;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.positionMs, 50);
    // suspended 时 WebAudio 时钟也停止，不用墙钟冒充实际播放位置。
    audio.state = "suspended";
    context.mock.timers.tick(1000);
    assert.equal(events.at(-1)!.state, "paused");
    assert.equal(events.at(-1)!.positionMs, 50);
    audio.state = "running";
    audio.currentTime = 0.09;
    context.mock.timers.tick(20);
    assert.equal(events.at(-1)!.state, "playing");
    assert.equal(events.at(-1)!.positionMs, 70);
  } finally { stream.stop(); }
});

test("VoicePlayer reuses one context and queues PCM until actual playback ends", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const originalContext = globalThis.AudioContext;
  Object.assign(globalThis, { AudioContext: AudioContextFixture });
  const events: PlaybackEvent[] = [];
  const player = new VoicePlayer((event) => events.push(event));
  try {
    await player.unlock();
    await player.unlock();
    const audio = AudioContextFixture.instances.at(-1)!;
    assert.equal(audio.resumed, 2, "unlock reuses the existing context");
    const pcm = Buffer.alloc(4410).toString("base64");
    player.append("first", VOICE_PCM_MIME, pcm, true);
    assert.equal(audio.sources.length, 1, "first chunk schedules before synthesis completion");
    player.complete("first");
    player.append("second", VOICE_PCM_MIME, pcm, true);
    player.complete("second");
    assert.equal(audio.sources.length, 1, "queued PCM must not overlap the first sentence");
    audio.currentTime = 0.07;
    context.mock.timers.tick(20);
    assert.deepEqual(events.at(-1), { sentenceId: "first", state: "playing", positionMs: 50 });
    audio.currentTime = 0.13;
    context.mock.timers.tick(20);
    assert.equal(events.some((event) => event.sentenceId === "first" && event.state === "ended"), true);
    assert.equal(audio.sources.length, 2);
    assert.ok(Math.abs(audio.sources[1]!.startAt! - 0.15) < 1e-8);
    audio.currentTime = 0.2;
    context.mock.timers.tick(20);
    assert.deepEqual(events.at(-1), { sentenceId: "second", state: "playing", positionMs: 50 });
    player.append("third", VOICE_PCM_MIME, pcm, true);
    player.stop();
    assert.equal(player.busy, false);
    assert.equal(audio.sources[1]!.stopped, true);
    audio.currentTime = 1;
    context.mock.timers.tick(100);
    assert.equal(audio.sources.length, 2, "interruption cannot activate queued sentences");
    assert.equal(events.some((event) => event.sentenceId === "second" && event.state === "ended"), false);
  } finally {
    player.dispose();
    Object.assign(globalThis, { AudioContext: originalContext });
  }
});
