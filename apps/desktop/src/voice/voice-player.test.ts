import assert from "node:assert/strict";
import test from "node:test";
import { VoicePlayer, pcmWave } from "./voice-player.ts";
import { VOICE_PCM_MIME } from "@semi-os/protocol";
import { floatToPcm16 } from "./pcm-recorder.ts";

class AudioFixture extends EventTarget {
  static instances: AudioFixture[] = [];
  src = "";
  paused = false;
  played = false;
  currentTime = 0;

  constructor() {
    super();
    AudioFixture.instances.push(this);
  }

  play(): Promise<void> {
    this.played = true;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  finish(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

test("PCM media output bypasses WebAudio and waits for actual playback", async () => {
  const originalAudio = globalThis.Audio;
  const originalContext = globalThis.AudioContext;
  const originalMediaSource = globalThis.MediaSource;
  Object.assign(globalThis, {
    Audio: AudioFixture,
    AudioContext: class {
      createMediaElementSource() {
        throw new Error("must not route media into WebAudio");
      }
    },
    MediaSource: {
      isTypeSupported() {
        throw new Error("PCM is not an MSE stream");
      },
    },
  });
  try {
    AudioFixture.instances = [];
    const events: string[] = [];
    const player = new VoicePlayer((event) => events.push(event.state), { mediaOutput: true });
    void player.audioContext;
    player.append("pcm_1", VOICE_PCM_MIME, "AQIDBA==", true);
    assert.equal(AudioFixture.instances[0]!.played, false);
    player.complete("pcm_1");
    assert.equal(AudioFixture.instances[0]!.played, true);
    assert.deepEqual(events, []);
    AudioFixture.instances[0]!.dispatchEvent(new Event("playing"));
    assert.deepEqual(events, ["playing"]);
    player.append("pcm_2", VOICE_PCM_MIME, "AQIDBA==", true);
    player.complete("pcm_2");
    AudioFixture.instances[0]!.finish();
    assert.equal(AudioFixture.instances.length, 2);
    assert.equal(AudioFixture.instances[1]!.played, true);
    player.stop();

    const wave = new DataView(
      await pcmWave([Uint8Array.of(1), Uint8Array.of(2, 3, 4)]).arrayBuffer(),
    );
    assert.equal(wave.getUint32(24, true), 22050);
    assert.equal(wave.getUint32(40, true), 4);
    assert.equal(wave.getUint16(44, true), 513);
    assert.throws(() => pcmWave([Uint8Array.of(1)]));
    assert.throws(() => pcmWave([]));
  } finally {
    Object.assign(globalThis, {
      Audio: originalAudio,
      AudioContext: originalContext,
      MediaSource: originalMediaSource,
    });
  }
});

test("queues a new sentence until the active sentence ends", () => {
  AudioFixture.instances = [];
  const originalAudio = globalThis.Audio;
  const originalMediaSource = globalThis.MediaSource;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  Object.assign(globalThis, {
    Audio: AudioFixture,
    MediaSource: undefined,
  });
  URL.createObjectURL = () => "blob:voice-fixture";
  URL.revokeObjectURL = () => {};

  try {
    const events: Array<{ state: string; positionMs: number }> = [];
    const player = new VoicePlayer((event) => events.push(event));
    player.append("sentence_1", "audio/mpeg", "AQID", true);
    player.complete("sentence_1");
    player.append("sentence_2", "audio/mpeg", "BAUG", true);
    player.complete("sentence_2");

    assert.equal(AudioFixture.instances.length, 1);
    assert.equal(AudioFixture.instances[0]?.played, true);
    assert.equal(AudioFixture.instances[0]?.paused, false);
    assert.equal(events.length, 0, "synthesis completion is not playback start");
    const audio = AudioFixture.instances[0]!;
    audio.dispatchEvent(new Event("playing"));
    audio.currentTime = 0.4;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("waiting"));
    audio.currentTime = 0.8;
    audio.dispatchEvent(new Event("timeupdate"));
    assert.deepEqual(
      events.map((event) => [event.state, event.positionMs]),
      [
        ["playing", 0],
        ["playing", 400],
        ["buffering", 400],
      ],
    );

    AudioFixture.instances[0]?.finish();

    assert.equal(AudioFixture.instances.length, 2);
    assert.equal(AudioFixture.instances[1]?.played, true);
  } finally {
    Object.assign(globalThis, {
      Audio: originalAudio,
      MediaSource: originalMediaSource,
    });
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("playback error clears all audio and never emits ended", () => {
  const originalAudio = globalThis.Audio;
  const originalMediaSource = globalThis.MediaSource;
  Object.assign(globalThis, { Audio: AudioFixture, MediaSource: undefined });
  try {
    const events: string[] = [];
    const player = new VoicePlayer((event) => events.push(event.state));
    player.append("failure", "audio/mpeg", "AQID", true);
    player.complete("failure");
    player.append("next", "audio/mpeg", "AQID", true);
    AudioFixture.instances.at(-1)!.dispatchEvent(new Event("error"));
    assert.equal(player.busy, false);
    assert.ok(events.includes("failed"));
    assert.equal(events.includes("ended"), false);
  } finally {
    Object.assign(globalThis, { Audio: originalAudio, MediaSource: originalMediaSource });
  }
});

test("stop interrupts the active sentence and clears queued audio", () => {
  AudioFixture.instances = [];
  const originalAudio = globalThis.Audio;
  const originalMediaSource = globalThis.MediaSource;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  Object.assign(globalThis, {
    Audio: AudioFixture,
    MediaSource: undefined,
  });
  URL.createObjectURL = () => "blob:voice-fixture";
  URL.revokeObjectURL = () => {};

  try {
    const player = new VoicePlayer();
    player.append("sentence_1", "audio/mpeg", "AQID", true);
    player.complete("sentence_1");
    player.append("sentence_2", "audio/mpeg", "BAUG", true);
    player.complete("sentence_2");
    player.stop();

    assert.equal(AudioFixture.instances[0]?.paused, true);
    AudioFixture.instances[0]?.finish();
    assert.equal(AudioFixture.instances.length, 1);
  } finally {
    Object.assign(globalThis, {
      Audio: originalAudio,
      MediaSource: originalMediaSource,
    });
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("direct media amplitude follows playback clock and resets on buffering and cancellation", () => {
  const originals = {
    Audio: globalThis.Audio,
    MediaSource: globalThis.MediaSource,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let frame: FrameRequestCallback | undefined;
  Object.assign(globalThis, {
    Audio: AudioFixture,
    MediaSource: undefined,
    requestAnimationFrame(callback: FrameRequestCallback) {
      frame = callback;
      return 1;
    },
    cancelAnimationFrame() {
      frame = undefined;
    },
  });
  try {
    const player = new VoicePlayer(() => {}, { mediaOutput: true });
    const pcm = floatToPcm16(Float32Array.from({ length: 2205 }, (_, i) => (i < 441 ? 0 : 0.2)));
    player.append("clock", VOICE_PCM_MIME, Buffer.from(pcm).toString("base64"), true);
    player.complete("clock");
    const audio = AudioFixture.instances.at(-1)!;
    audio.dispatchEvent(new Event("playing"));
    frame!(0);
    assert.equal(player.audioLevel.current, 0, "silent audio must not create a synthetic waveform");
    audio.currentTime = 0.04;
    frame!(20);
    assert.ok(player.audioLevel.current > 0.3);
    audio.dispatchEvent(new Event("waiting"));
    assert.equal(player.audioLevel.current, 0);
    frame!(40);
    assert.equal(player.audioLevel.current, 0, "buffering cannot advance the envelope");
    audio.dispatchEvent(new Event("playing"));
    frame!(60);
    assert.ok(player.audioLevel.current > 0);
    player.stop();
    assert.equal(player.audioLevel.current, 0);
    assert.equal(frame, undefined);
  } finally {
    Object.assign(globalThis, originals);
  }
});
