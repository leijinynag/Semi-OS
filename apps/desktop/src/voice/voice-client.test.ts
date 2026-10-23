import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { VoiceClient } from "./voice-client.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Request {
  requestId: string;
  kind: string;
  payload: {
    sequence?: number;
    lastSequence?: number;
    text?: string;
    sessionId?: string;
    cwd?: string;
  };
}

/** 替换设备与 IPC 边界，真实执行控制器和重采样器，不把 Mock 当真人验收。 */
async function setup(t: TestContext, hold?: { kind: string; promise: Promise<void> }) {
  const requests: Request[] = [];
  const streams: { stopped: number; getTracks(): { stop(): void }[] }[] = [];
  const processors: Processor[] = [];
  const contexts: Context[] = [];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let denyMicrophone = false;
  const deviceListeners = new Map<string, () => void>();
  class Context {
    constructor() {
      contexts.push(this);
    }
    sampleRate = 48_000;
    state = "running";
    destination = {};
    audioWorklet = { async addModule() {} };
    async resume() {
      this.state = "running";
    }
    async close() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
  }
  class Processor {
    token?: number;
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (value: { kind: string; token: number }) => {
        if (value.kind === "begin") this.token = value.token;
        else {
          this.token = undefined;
          this.port.onmessage?.({ data: { kind: "flushed", token: value.token } });
        }
      },
      close() {},
    };
    constructor() {
      processors.push(this);
    }
    connect() {}
    disconnect() {}
    samples(count = 4800, level = 0.25) {
      if (this.token === undefined) return;
      this.port.onmessage?.({
        data: {
          kind: "samples",
          token: this.token,
          samples: new Float32Array(count).fill(level),
        },
      });
    }
  }
  const globals = {
    window: { crypto: globalThis.crypto },
    AudioContext: Context,
    AudioWorkletNode: Processor,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          if (hold?.kind === "getUserMedia") await hold.promise;
          if (denyMicrophone) throw new Error("microphone denied");
          const stream = {
            stopped: 0,
            getTracks() {
              return [
                {
                  stop() {
                    stream.stopped++;
                  },
                },
              ];
            },
          };
          streams.push(stream);
          return stream;
        },
        addEventListener(name: string, listener: () => void) {
          deviceListeners.set(name, listener);
        },
        removeEventListener(name: string) {
          deviceListeners.delete(name);
        },
      },
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let held = false;
  let activeSessionId = "session_test";
  mockIPC(
    async (command, args) => {
      if (command === "get_voice_settings") return { enabled: true, prewarm: true };
      if (command === "get_agent_workspace") return "/tmp/semi-os-runtime";
      if (command === "start_voice_conversation") {
        if (hold?.kind === command && !held) {
          held = true;
          await hold.promise;
        }
        return activeSessionId;
      }
      if (command === "activate_client_session") {
        if (hold?.kind === command && !held) {
          held = true;
          await hold.promise;
        }
        activeSessionId = (args as { sessionId: string }).sessionId;
        return activeSessionId;
      }
      if (command === "send_worker_request") {
        const request = (args as { envelope: Request }).envelope;
        requests.push(request);
        if (request.kind === hold?.kind && !held) {
          held = true;
          await hold.promise;
        }
      }
    },
    { shouldMockEvents: true },
  );
  const client = new VoiceClient();
  t.after(async () => {
    client.dispose();
    await settle();
    clearMocks();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await client.connect();
  await settle();
  return {
    client,
    requests,
    streams,
    processors,
    contexts,
    devicechange: () => deviceListeners.get("devicechange")?.(),
    denyMicrophone: () => {
      denyMicrophone = true;
    },
  };
}

test("capture and playback own separate reusable audio contexts", async (t) => {
  const { client, contexts, processors } = await setup(t);
  assert.equal(contexts.length, 1, "connect preloads only the capture context");
  await client.start();
  processors[0]!.samples();
  await client.stop();
  assert.equal(contexts.length, 2, "playback must not reuse the microphone context");
  await client.start();
  processors.at(-1)!.samples();
  await client.stop();
  assert.equal(contexts.length, 2, "contexts are reused, not recreated per turn");
});

test("manual cancellation discards capture and permits the next voice turn", async (t) => {
  const { client, processors, requests } = await setup(t);
  await client.start();
  assert.equal(client.capturing, true);
  processors[0]!.samples();
  await client.cancelRecording();
  assert.equal(client.capturing, false);
  assert.equal(requests.filter((r) => r.kind === "voice.turn.commit").length, 0);
  const count = requests.length;
  await client.cancelRecording();
  assert.equal(requests.length, count, "idle cancellation must not cancel another task");
  await client.start();
  processors[0]!.samples();
  await client.stop();
  assertCommittedTurns(requests, 1);
});

function assertCommittedTurns(requests: Request[], count: number) {
  const turns = new Map<string, { next: number; committed: boolean }>();
  for (const request of requests) {
    if (request.kind === "voice.turn.start") {
      turns.set(request.requestId, { next: 0, committed: false });
    } else if (request.kind === "voice.audio.append") {
      const turn = turns.get(request.requestId)!;
      assert.ok(turn && !turn.committed, "audio must belong to an open turn");
      assert.equal(request.payload.sequence, turn.next++);
    } else if (request.kind === "voice.turn.commit") {
      const turn = turns.get(request.requestId)!;
      assert.ok(turn && !turn.committed, "each turn commits once");
      assert.equal(request.payload.lastSequence, turn.next - 1);
      assert.ok(turn.next > 0);
      turn.committed = true;
    }
  }
  assert.equal([...turns.values()].filter((turn) => turn.committed).length, count);
}

for (const kind of ["voice.audio.append", "voice.turn.commit"]) {
  test(`next press cannot replace turn identity while ${kind} is pending`, async (t) => {
    const gate = deferred();
    t.after(gate.resolve);
    const { client, requests, processors, streams } = await setup(t, {
      kind,
      promise: gate.promise,
    });
    await client.start();
    processors[0]!.samples();
    processors[0]!.samples();
    await settle();
    const firstStop = client.stop();
    const duplicateStop = client.stop();
    await settle();
    const nextStart = client.start();
    await settle();
    const startedBeforeCommit = requests.filter(
      (request) => request.kind === "voice.turn.start",
    ).length;
    gate.resolve();
    await Promise.all([firstStop, duplicateStop, nextStart]);
    processors.at(-1)!.samples();
    assert.equal(streams.length, 1, "the device stays warm across turns");
    assert.equal(streams[0]!.stopped, 0, "previous cleanup must not stop the next microphone");
    await client.stop();
    assert.equal(startedBeforeCommit, 1, "new turn must wait for the previous commit");
    assertCommittedTurns(requests, 2);
  });
}

test("release during Host setup flushes immediately and preserves the short tail", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, requests, processors, streams } = await setup(t, {
    kind: "start_voice_conversation",
    promise: gate.promise,
  });
  const start = client.start();
  await settle();
  processors[0]!.samples(480, 0.5);
  const stop = client.stop();
  await settle();
  assert.equal(processors[0]!.token, undefined, "release closes the gate, not the device");
  assert.equal(streams[0]!.stopped, 0);
  assert.equal(requests.length, 0);
  gate.resolve();
  await Promise.all([start, stop]);
  assertCommittedTurns(requests, 1);
});

test("a new short recording is captured even while the previous commit is pending", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, requests, processors, streams } = await setup(t, {
    kind: "voice.turn.commit",
    promise: gate.promise,
  });
  await client.start();
  processors[0]!.samples();
  const stop = client.stop();
  await settle();
  const nextStart = client.start();
  assert.notEqual(processors[0]!.token, undefined);
  processors[0]!.samples(480, 0.5);
  const nextStop = client.stop();
  gate.resolve();
  await Promise.all([stop, nextStart, nextStop]);
  assert.equal(streams[0]!.stopped, 0);
  assert.equal(processors[0]!.token, undefined);
  assertCommittedTurns(requests, 2);
});

test("permission denial and an empty quick press never commit an empty turn", async (t) => {
  const { client, requests, denyMicrophone } = await setup(t);
  await client.start();
  await client.stop();
  await client.configure({ enabled: true, prewarm: false });
  denyMicrophone();
  const start = client.start();
  const stop = client.stop();
  await Promise.all([start, stop]);
  assert.equal(requests.filter((request) => request.kind === "voice.turn.commit").length, 0);
});

test("a failed audio send is cleaned up and the following turn starts from sequence zero", async (t) => {
  let reject!: (error: Error) => void;
  const failure = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const { client, requests, processors, streams } = await setup(t, {
    kind: "voice.audio.append",
    promise: failure,
  });
  await client.start();
  processors[0]!.samples();
  await settle();
  const stop = client.stop();
  await settle();
  reject(new Error("synthetic IPC failure"));
  await stop;
  assert.equal(streams[0]!.stopped, 0);
  assert.equal(requests.filter((request) => request.kind === "voice.turn.commit").length, 0);
  await client.start();
  processors[0]!.samples();
  await client.stop();
  assertCommittedTurns(requests, 1);
});

test("idle audio is discarded and disabling voice releases the device", async (t) => {
  const { client, requests, processors, streams } = await setup(t);
  processors[0]!.samples();
  assert.equal(requests.length, 0);
  await client.start();
  processors[0]!.samples();
  await client.stop();
  const count = requests.length;
  processors[0]!.samples();
  assert.equal(requests.length, count);
  await client.configure({ enabled: false, prewarm: true });
  assert.equal(streams[0]!.stopped, 1);
  await client.start();
  assert.equal(requests.filter((request) => request.kind === "voice.turn.start").length, 1);
});

test("all-silence capture is distinct from an empty capture and is not committed", async (t) => {
  const { client, requests, processors } = await setup(t);
  let error = "";
  client.subscribe((snapshot) => {
    error = snapshot.error ?? "";
  });
  await client.start();
  processors[0]!.samples(4800, 0);
  await client.stop();
  assert.match(error, /静音/);
  assert.equal(requests.filter((request) => request.kind === "voice.turn.commit").length, 0);
});

test("disabling voice releases the microphone before a pending network commit finishes", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, processors, streams } = await setup(t, {
    kind: "voice.turn.commit",
    promise: gate.promise,
  });
  await client.start();
  processors[0]!.samples();
  const stop = client.stop();
  await settle();
  const disabling = client.configure({ enabled: false, prewarm: true });
  await settle();
  assert.equal(
    streams[0]!.stopped,
    1,
    "settings must not wait for network cleanup to release the device",
  );
  gate.resolve();
  await Promise.all([stop, disabling]);
});

test("disposal prevents buffered audio from being sent after a pending append", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, processors, requests } = await setup(t, {
    kind: "voice.audio.append",
    promise: gate.promise,
  });
  await client.start();
  processors[0]!.samples();
  processors[0]!.samples();
  await settle();
  const stop = client.stop();
  client.dispose();
  gate.resolve();
  await stop;
  assert.equal(requests.filter((request) => request.kind === "voice.audio.append").length, 1);
  assert.equal(requests.filter((request) => request.kind === "voice.turn.commit").length, 0);
});

test("three local captures remain independent while the first network commit waits", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, processors, requests } = await setup(t, {
    kind: "voice.turn.commit",
    promise: gate.promise,
  });
  await client.start();
  processors[0]!.samples();
  const first = client.stop();
  await settle();
  const secondStart = client.start();
  processors[0]!.samples(480, 0.3);
  const second = client.stop();
  const thirdStart = client.start();
  await settle();
  processors[0]!.samples(480, 0.6);
  const third = client.stop();
  gate.resolve();
  await Promise.all([first, secondStart, second, thirdStart, third]);
  assertCommittedTurns(requests, 3);
});

test("pending microphone authorization does not block connect and disposal prevents a late device", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, streams, processors, requests } = await setup(t, {
    kind: "getUserMedia",
    promise: gate.promise,
  });
  assert.equal(streams.length, 0, "connect returns before the permission dialog");
  client.dispose();
  gate.resolve();
  await settle();
  assert.equal(streams[0]!.stopped, 1, "late permission must release the track");
  assert.equal(processors.length, 0, "disposed capture must not attach a Worklet");
  assert.equal(requests.length, 0);
});

test("device changes rebuild idle capture and a suspended clock resumes before a new turn", async (t) => {
  const { client, streams, processors, contexts, requests, devicechange } = await setup(t);
  devicechange();
  await settle();
  assert.equal(streams[0]!.stopped, 1);
  assert.equal(streams.length, 2);
  contexts[0]!.state = "suspended";
  await client.start();
  assert.equal(contexts[0]!.state, "running");
  processors.at(-1)!.samples();
  await client.stop();
  assertCommittedTurns(requests, 1);
  assert.equal(streams[1]!.stopped, 0);
});

test("text input works with voice disabled and microphone denied without audio requests", async (t) => {
  const { client, requests, streams, denyMicrophone } = await setup(t);
  await client.configure({ enabled: false, prewarm: false });
  denyMicrophone();
  const count = streams.length;
  await client.submitText("  你好  ");
  assert.equal(streams.length, count);
  const text = requests.find((request) => request.kind === "voice.text.submit")!;
  assert.equal(text.payload.text, "你好");
  assert.equal(text.payload.sessionId, "session_test");
  assert.equal(text.payload.cwd, "/tmp/semi-os-runtime");
  assert.ok(
    !requests.some((request) =>
      ["voice.turn.start", "voice.audio.append", "voice.turn.commit"].includes(request.kind),
    ),
  );
});

test("pending microphone authorization cannot block a text turn", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, requests, streams } = await setup(t, {
    kind: "getUserMedia",
    promise: gate.promise,
  });
  await client.submitText("无需麦克风");
  assert.equal(streams.length, 0);
  assert.equal(requests.at(-1)?.kind, "voice.text.submit");
});

test("late microphone denial and prewarm settings cannot overwrite a text turn", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, denyMicrophone } = await setup(t, {
    kind: "getUserMedia",
    promise: gate.promise,
  });
  let state = "";
  let error: string | undefined;
  client.subscribe((snapshot) => {
    state = snapshot.state;
    error = snapshot.error;
  });
  await client.submitText("文字不依赖麦克风授权");
  denyMicrophone();
  gate.resolve();
  await settle();
  assert.equal(state, "thinking");
  assert.equal(error, undefined);
  await client.configure({ enabled: true, prewarm: true });
  assert.equal(state, "thinking");
  assert.equal(error, undefined);
});

test("text submission rejects invalid input and propagates transport failure", async (t) => {
  let reject!: (reason: Error) => void;
  const failure = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const { client, requests } = await setup(t, { kind: "voice.text.submit", promise: failure });
  await assert.rejects(client.submitText(" \n"));
  await assert.rejects(client.submitText("a".repeat(64_001)));
  assert.equal(requests.length, 0);
  const submit = client.submitText("测试");
  const rejection = assert.rejects(submit, /synthetic/);
  await settle();
  reject(new Error("synthetic failure"));
  await rejection;
  await client.submitText("再次测试");
  assert.equal(requests.filter((request) => request.kind === "voice.text.submit").length, 2);
});

test("text closes an active capture without committing an extra speech turn", async (t) => {
  const { client, requests, processors } = await setup(t);
  await client.start();
  processors[0]!.samples();
  await client.submitText("改用文字");
  assert.equal(processors[0]!.token, undefined);
  assert.equal(requests.filter((request) => request.kind === "voice.turn.commit").length, 0);
  assert.equal(requests.filter((request) => request.kind === "voice.text.submit").length, 1);
  assert.ok(requests.some((request) => request.kind === "voice.interrupt"));
});

test("session switch discards capture and the next text uses the Host-selected session", async (t) => {
  const { client, requests, processors } = await setup(t);
  await client.start();
  processors[0]!.samples();
  await client.switchSession("session_next", "change_1");
  assert.equal(processors[0]!.token, undefined);
  assert.ok(!requests.some((request) => request.kind === "voice.turn.commit"));
  await client.submitText("新会话");
  assert.equal(requests.at(-1)?.payload.sessionId, "session_next");
});

test("pending session switch blocks new capture and text until Host activation", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const { client, requests, processors } = await setup(t, {
    kind: "activate_client_session",
    promise: gate.promise,
  });
  const switching = client.switchSession("session_next", "change_1");
  await settle();
  await client.start();
  assert.equal(processors[0]!.token, undefined);
  await assert.rejects(client.submitText("切换中"), /会话正在切换/);
  assert.equal(requests.length, 0);
  gate.resolve();
  await switching;
  await client.submitText("已切换");
  assert.equal(requests.at(-1)?.payload.sessionId, "session_next");
});

test("failed session activation retains Host selection and permits subsequent input", async (t) => {
  let reject!: (error: Error) => void;
  const failure = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const { client, requests } = await setup(t, {
    kind: "activate_client_session",
    promise: failure,
  });
  const switching = client.switchSession("session_next", "change_1");
  const rejected = assert.rejects(switching, /expired/);
  await settle();
  reject(new Error("expired request"));
  await rejected;
  await client.submitText("仍在旧会话");
  assert.equal(requests.at(-1)?.payload.sessionId, "session_test");
});
