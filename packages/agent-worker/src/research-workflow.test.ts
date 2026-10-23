import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  SessionManager,
  ToolDefinition as PiTool,
} from "@earendil-works/pi-coding-agent";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { ResearchSource, ResearchReport, Envelope } from "@semi-os/protocol";
import { decodeJsonl, encodeJsonl } from "@semi-os/protocol";
import { BrowserService } from "./browser/browser-service.ts";
import { createBrowserTools } from "./browser/browser-tools.ts";
import { ResearchHost } from "./research-host.ts";
import { PiAgentRuntime } from "./pi-runtime.ts";
import { VoiceLoop, type VoiceLoopEvent } from "./voice/voice-loop.ts";
import { FakeSttProvider, FakeTtsProvider } from "./voice/fake-providers.ts";
import { WorkerService } from "./worker-service.ts";

/** Fake 模型只替换 Pi Session；浏览器、执行器、Host 回执协议和语音编排均为真实代码。 */
test("research round trip: silent progress, conflicting sources, blocked source, citations and spoken briefing", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "semi-workflow-"));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const text =
      request.url === "/a"
        ? "产品支持自动搜索。"
        : request.url === "/b"
          ? "产品仅支持手动搜索。"
          : "登录后继续查看";
    response.end(`<title>来源 ${request.url}</title><article>${text}</article>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const sources: ResearchSource[] = [];
  let report: ResearchReport | undefined;
  let host!: ResearchHost;
  host = new ResearchHost((message: Envelope) => {
    message = decodeJsonl(encodeJsonl(message));
    if (message.direction !== "event") return;
    const payload = message.payload as { operationId: string; operation: string; value: unknown };
    if (payload.operation === "source") sources.push(payload.value as ResearchSource);
    else if (payload.operation === "report") {
      const value = payload.value as ResearchReport;
      assert.ok(
        value.claims.every((claim) =>
          claim.citations.every((citation) =>
            sources.some(
              (source) =>
                source.status === "collected" &&
                source.sourceId === citation.sourceId &&
                source.quotes.some((quote) => quote.quoteId === citation.quoteId),
            ),
          ),
        ),
      );
      report = value;
    }
    host.acknowledge({ operationId: payload.operationId, ok: true });
  });
  const browser = new BrowserService({ profileDir: profile, headless: true });
  const tts = new FakeTtsProvider();
  const events: VoiceLoopEvent[] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let tools: PiTool[] = [];
  const send = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const delta = (text: string) =>
    send({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: {} as never,
      },
    });
  let count = 0;
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name)!;
    const callId = `fixture_${++count}`;
    send({ type: "tool_execution_start", toolCallId: callId, toolName: name, args: input });
    const result = await tool.execute(
      callId,
      input,
      new AbortController().signal,
      undefined,
      {} as never,
    );
    return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
  };
  const runtime = new PiAgentRuntime({
    baseToolNames: [],
    createResourceLoader: () => ({ async reload() {} }) as ResourceLoader,
    createSessionManager: () => ({ getSessionFile: () => "/tmp/fixture.jsonl" }) as SessionManager,
    createSession: (async (options: Parameters<typeof createAgentSession>[0]) => {
      tools = options?.customTools ?? [];
      return {
        session: {
          sessionId: "pi_fixture",
          messages: [],
          isStreaming: false,
          subscribe(listener: (event: AgentSessionEvent) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async prompt() {
            assert.ok(events.some((event) => event.kind === "voice.state"));
            assert.equal(tts.spoken.length, 0);
            const extracted: Array<Record<string, unknown>> = [];
            for (const path of ["/a", "/b", "/blocked"]) {
              const page = await call("browser_open", { url: base + path });
              if (page.status === "ready")
                extracted.push(await call("browser_extract", { pageId: page.pageId }));
            }
            delta("两份原文对搜索能力的描述存在冲突。");
            delta(
              "```research-report\n" +
                JSON.stringify({
                  summary: "搜索能力存在来源冲突",
                  claims: [
                    {
                      text: "两份来源描述不一致",
                      citations: extracted.map((item) => ({
                        sourceId: item.sourceId,
                        quoteId: item.quoteId,
                      })),
                    },
                  ],
                  limitations: ["第三份来源需要登录，未核验"],
                }) +
                "\n```",
            );
            send({ type: "agent_end", messages: [], willRetry: false });
          },
          dispose() {},
        } as unknown as AgentSession,
        extensionsResult: { extensions: [] },
      };
    }) as never,
  });
  const wireEvents: Envelope[] = [];
  const worker = new WorkerService({
    // 不能仅收集内存对象：生产环境在 stdout 写入前会严格检查 JSONL。
    emit: (event) => {
      wireEvents.push(decodeJsonl(encodeJsonl(event)));
    },
    createVoiceLoop: (emit) =>
      new VoiceLoop({
        runtime,
        stt: new FakeSttProvider("比较产品的搜索能力"),
        tts: {
          async *synthesize(input) {
            for await (const event of tts.synthesize(input)) {
              // Fake 音频不实际播放，但跨 IPC 的 MIME 必须符合生产协议。
              yield event.kind === "tts.audio"
                ? { ...event, mimeType: "audio/pcm;rate=22050;channels=1;format=s16le" }
                : event;
            }
          },
        },
        tools: createBrowserTools(browser, host),
        saveReport: (value, signal) => host.report(value, signal),
        emit: (event) => {
          events.push(event);
          emit(event);
        },
      }),
  });
  t.after(async () => {
    await worker.dispose();
    host.dispose();
    await browser.dispose();
    server.close();
    await rm(profile, { recursive: true, force: true });
  });
  await worker.handle({
    direction: "request",
    protocolVersion: 1,
    requestId: "req_research" as never,
    kind: "voice.text.submit",
    payload: {
      sessionId: "session_research",
      taskId: "task_research",
      cwd: tmpdir(),
      text: "比较产品的搜索能力",
    },
  });
  const deadline = Date.now() + 15_000;
  while (!wireEvents.some((event) => event.kind === "voice.turn.completed")) {
    assert.ok(
      !wireEvents.some((event) => event.kind === "voice.error"),
      "worker must deliver browser results without serialization errors",
    );
    assert.ok(Date.now() < deadline, "timed out waiting for browser research");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sources.filter((source) => source.status === "collected").length, 2);
  assert.equal(sources.filter((source) => source.status === "needs_user").length, 1);
  assert.equal(report?.claims[0]?.citations.length, 2);
  assert.equal(tts.spoken[0], "两份原文对搜索能力的描述存在冲突。");
  assert.equal(
    tts.spoken.some((text) => text === "搜索资料。"),
    false,
  );
  assert.ok(tts.spoken.includes("两份原文对搜索能力的描述存在冲突。"));
  assert.equal(
    tts.spoken.some((text) => text.includes("research-report")),
    false,
  );
  assert.equal(events.filter((event) => event.kind === "research.receipt").length, 5);
  const receipts = wireEvents.filter((event) => event.kind === "research.receipt");
  assert.equal(receipts.length, 5);
  assert.ok(
    receipts.every((event) => !Object.hasOwn(event.payload as Record<string, unknown>, "approval")),
  );
  assert.equal(
    receipts.filter((event) => (event.payload as Record<string, unknown>).status === "succeeded")
      .length,
    4,
  );
  assert.equal(
    receipts.filter((event) => (event.payload as Record<string, unknown>).status === "needs_user")
      .length,
    1,
  );
  assert.ok(events.some((event) => event.kind === "voice.turn.completed"));
});
