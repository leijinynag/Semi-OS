import assert from "node:assert/strict";
import test from "node:test";
import { VoicePlayer } from "./voice-player.ts";

class AudioFixture extends EventTarget {
  static instances: AudioFixture[] = [];
  src = "";
  paused = false;
  played = false;

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
    const player = new VoicePlayer();
    player.append("sentence_1", "audio/mpeg", "AQID", true);
    player.complete("sentence_1");
    player.append("sentence_2", "audio/mpeg", "BAUG", true);
    player.complete("sentence_2");

    assert.equal(AudioFixture.instances.length, 1);
    assert.equal(AudioFixture.instances[0]?.played, true);
    assert.equal(AudioFixture.instances[0]?.paused, false);

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
