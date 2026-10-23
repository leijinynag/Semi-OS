import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionFactory,
  ResourceLoader,
  SessionManager,
  ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition, ToolExecutionReceipt } from "@semi-os/tool-sdk";
import { AgentRuntimeStateError, type AgentCheckpoint } from "./runtime.ts";
import { PiAgentRuntime } from "./pi-runtime.ts";
import { VOICE_SYSTEM_PROMPT } from "./voice/system-prompt.ts";
import { ResearchHost } from "./research-host.ts";
import type { Envelope } from "@semi-os/protocol";

interface SessionFixture {
  session: AgentSession;
  emit(event: AgentSessionEvent): void;
  activeTools: string[];
  prompts: string[];
  aborted: boolean;
  disposed: boolean;
}

type ToolCallHandler = (event: {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>;

type ToolEndHandler = (event: {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}) => Promise<void>;

interface ExtensionFixture {
  resourceLoader: ResourceLoader;
  toolCall?: ToolCallHandler;
  toolEnd?: ToolEndHandler;
}

function createExtensionFixture(): ExtensionFixture {
  return { resourceLoader: emptyResources() };
}

function emptyResources(): ResourceLoader {
  return { async reload() {} } as ResourceLoader;
}

async function loadExtension(
  fixture: ExtensionFixture,
  extension: ExtensionFactory,
): Promise<void> {
  const api = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") {
        fixture.toolCall = handler as ToolCallHandler;
      }
      if (event === "tool_execution_end") {
        fixture.toolEnd = handler as ToolEndHandler;
      }
    },
  } as unknown as ExtensionAPI;
  await extension(api);
}

function sessionManagerFixture(path = "/tmp/semi-os/pi-session.jsonl"): SessionManager {
  return {
    getSessionFile: () => path,
  } as unknown as SessionManager;
}

function createSessionFixture(): SessionFixture {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const fixture = {
    activeTools: [] as string[],
    prompts: [] as string[],
    aborted: false,
    disposed: false,
  };
  const session = {
    sessionId: "pi_session_fixture",
    messages: [],
    isStreaming: false,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      fixture.prompts.push(text);
    },
    async steer(text: string) {
      fixture.prompts.push(`steer:${text}`);
    },
    async followUp(text: string) {
      fixture.prompts.push(`follow-up:${text}`);
    },
    async abort() {
      fixture.aborted = true;
    },
    setActiveToolsByName(names: string[]) {
      fixture.activeTools = names;
    },
    getActiveToolNames() {
      return fixture.activeTools;
    },
    dispose() {
      fixture.disposed = true;
    },
  } as unknown as AgentSession;

  return {
    ...fixture,
    session,
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function productTool(name = "browser_open"): ToolDefinition {
  return {
    name,
    description: "Open a browser page",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    requiredCapabilities: ["browser.playwright"],
    async execute(input) {
      return {
        output: input,
        outputSummary: `opened ${String(input.url)}`,
      };
    },
    async verify() {
      return {
        status: "passed",
        method: "fixture",
        summary: "url matched",
        evidence: [{ kind: "fixture", reference: "browser:url" }],
      };
    },
  };
}

test("maps Pi session events and product tools through the adapter boundary", async () => {
  const fixture = createSessionFixture();
  let customTools: PiToolDefinition[] = [];
  const runtime = new PiAgentRuntime({
    now: (() => {
      let now = 10;
      return () => now++;
    })(),
    createSession: (async (options: Parameters<typeof createAgentSession>[0]) => {
      customTools = options?.customTools ?? [];
      fixture.activeTools = options?.tools ?? [];
      return { session: fixture.session, extensionsResult: { extensions: [] } };
    }) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: emptyResources,
  });
  const events: unknown[] = [];
  runtime.subscribe((event) => events.push(event));

  const handle = await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [productTool()],
  });
  await runtime.prompt({ taskId: "task_1", text: "open example" });
  fixture.emit({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Done",
      partial: {} as never,
    },
  });
  fixture.emit({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "browser_open",
    args: { url: "https://example.com" },
  });
  await customTools[0]!.execute(
    "call_1",
    { url: "https://example.com" },
    undefined,
    undefined,
    {} as never,
  );
  fixture.emit({ type: "agent_end", messages: [], willRetry: false });
  const terminalCount = events.length;
  fixture.emit({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(events.length, terminalCount, "Pi retry must not complete the product turn");
  for (const stopReason of ["aborted", "error"] as const) {
    fixture.emit({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason, content: [] } as never],
    });
    assert.equal((events.at(-1) as { kind: string }).kind, "runtime.error");
  }

  assert.equal(handle.runtimeSessionRef, "pi_session_fixture");
  assert.deepEqual(fixture.prompts, ["open example"]);
  assert.deepEqual(fixture.activeTools, ["read", "bash", "edit", "write", "browser_open"]);
  assert.equal(
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "kind" in event &&
        event.kind === "assistant.text_delta",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "kind" in event &&
        event.kind === "tool.completed",
    ),
    true,
  );
  assert.equal((await runtime.checkpoint()).sequence, 1);
});

test("passes the configured cloud model into the Pi session", async () => {
  const fixture = createSessionFixture();
  const model = {
    provider: "fixture-provider",
    id: "fixture-model",
  } as Model<any>;
  let receivedModel: Model<any> | undefined;
  const runtime = new PiAgentRuntime({
    model,
    createSession: (async (options: Parameters<typeof createAgentSession>[0]) => {
      receivedModel = options?.model;
      return { session: fixture.session, extensionsResult: { extensions: [] } };
    }) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: emptyResources,
  });

  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [],
  });

  assert.equal(receivedModel, model);
});

test("rejects tools that were not registered when the Pi session started", async () => {
  const fixture = createSessionFixture();
  const runtime = new PiAgentRuntime({
    createSession: (async () => ({
      session: fixture.session,
      extensionsResult: { extensions: [] },
    })) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: emptyResources,
  });
  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [productTool()],
  });

  await assert.rejects(
    runtime.replaceTools([productTool("desktop_click")]),
    AgentRuntimeStateError,
  );
});

test("requires an explicit policy approval before a high-risk tool executes", async () => {
  const fixture = createSessionFixture();
  let customTools: PiToolDefinition[] = [];
  const runtime = new PiAgentRuntime({
    createSession: (async (options: Parameters<typeof createAgentSession>[0]) => {
      customTools = options?.customTools ?? [];
      return { session: fixture.session, extensionsResult: { extensions: [] } };
    }) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: emptyResources,
  });
  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [
      {
        ...productTool("lark_send_message"),
        riskLevel: "external_side_effect",
      },
    ],
  });
  await runtime.prompt({ taskId: "task_1", text: "send it" });

  await assert.rejects(
    customTools[0]!.execute("call_1", { text: "hello" }, undefined, undefined, {} as never),
    /confirmation_required/,
  );
});

test("publishes terminal receipts when custom tool stages throw", async () => {
  const fixture = createSessionFixture();
  let customTools: PiToolDefinition[] = [];
  const runtime = new PiAgentRuntime({
    createSession: (async (options: Parameters<typeof createAgentSession>[0]) => {
      customTools = options?.customTools ?? [];
      return { session: fixture.session, extensionsResult: { extensions: [] } };
    }) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: emptyResources,
  });
  const receipts: ToolExecutionReceipt[] = [];
  runtime.subscribe((event) => {
    if (event.kind === "tool.completed") {
      receipts.push(event.receipt);
    }
  });
  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [
      {
        ...productTool("read_failure"),
        async execute() {
          throw new Error("read failed");
        },
      },
      {
        ...productTool("write_verify_failure"),
        riskLevel: "local_write",
        contract: {
          mutation: { kind: "workspace", atomic: true },
          verification: { required: true, method: "tool" },
        },
        async verify() {
          throw new Error("verification unavailable");
        },
      },
    ],
  });
  await runtime.prompt({ taskId: "task_1", text: "run failures" });

  await assert.rejects(
    customTools[0]!.execute("call_read", {}, undefined, undefined, {} as never),
    /read failed/,
  );
  await assert.rejects(
    customTools[1]!.execute(
      "call_write",
      { url: "https://example.com" },
      undefined,
      undefined,
      {} as never,
    ),
    /verification unavailable/,
  );

  assert.deepEqual(
    receipts.map((receipt) => [
      receipt.toolName,
      receipt.status,
      receipt.resultType,
      receipt.verification?.status,
    ]),
    [
      ["read_failure", "failed", "failure", "not_run"],
      ["write_verify_failure", "unknown", "unknown", "inconclusive"],
    ],
  );
  assert.equal((await runtime.checkpoint()).sequence, 2);
});

test("applies policy and emits receipts for Pi native tools", async () => {
  const fixture = createSessionFixture();
  const extensionFixture = createExtensionFixture();
  const policyInputs: Array<{
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const receipts: ToolExecutionReceipt[] = [];
  const runtime = new PiAgentRuntime({
    createSession: (async () => ({
      session: fixture.session,
      extensionsResult: { extensions: [] },
    })) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: ({ extension }) => {
      const factory = typeof extension === "function" ? extension : extension.factory;
      void loadExtension(extensionFixture, factory);
      return extensionFixture.resourceLoader;
    },
    resolvePolicyDecision: async (tool, input) => {
      policyInputs.push({ name: tool.name, input: { ...input } });
      return tool.name === "bash" ? "confirmation_required" : "auto";
    },
  });
  runtime.subscribe((event) => {
    if (event.kind === "tool.completed") {
      receipts.push(event.receipt);
    }
  });
  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [],
  });
  await runtime.prompt({ taskId: "task_1", text: "inspect files" });

  const blocked = await extensionFixture.toolCall?.({
    type: "tool_call",
    toolCallId: "call_bash",
    toolName: "bash",
    input: { command: "git status" },
  });
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.terminate, true);

  const allowed = await extensionFixture.toolCall?.({
    type: "tool_call",
    toolCallId: "call_read",
    toolName: "read",
    input: { path: "README.md" },
  });
  assert.equal(allowed, undefined);
  await extensionFixture.toolEnd?.({
    type: "tool_execution_end",
    toolCallId: "call_read",
    toolName: "read",
    result: { content: [{ type: "text", text: "contents" }] },
    isError: false,
  });

  assert.deepEqual(policyInputs, [
    { name: "bash", input: { command: "git status" } },
    { name: "read", input: { path: "README.md" } },
  ]);
  assert.deepEqual(
    receipts.map((receipt) => [
      receipt.toolName,
      receipt.riskLevel,
      receipt.status,
      receipt.policyDecision,
    ]),
    [
      ["bash", "privileged", "needs_user", "confirmation_required"],
      ["read", "read", "succeeded", "auto"],
    ],
  );
});

test("records native authorization failures and resumes paused sessions through prompt", async () => {
  const fixture = createSessionFixture();
  const extensionFixture = createExtensionFixture();
  const receipts: ToolExecutionReceipt[] = [];
  let deny = true;
  const runtime = new PiAgentRuntime({
    createSession: (async () => ({
      session: fixture.session,
      extensionsResult: { extensions: [] },
    })) as never,
    createSessionManager: () => sessionManagerFixture(),
    createResourceLoader: ({ extension }) => {
      const factory = typeof extension === "function" ? extension : extension.factory;
      void loadExtension(extensionFixture, factory);
      return extensionFixture.resourceLoader;
    },
    resolvePolicyDecision: async () => {
      if (deny) throw new Error("Host unavailable");
      return "auto";
    },
  });
  runtime.subscribe((event) => {
    if (event.kind === "tool.completed") receipts.push(event.receipt);
  });
  await runtime.startSession({ sessionId: "session_resume", cwd: "/tmp", tools: [] });
  await runtime.prompt({ taskId: "task_resume", text: "first" });
  const call = (id: string) =>
    extensionFixture.toolCall?.({
      type: "tool_call",
      toolCallId: id,
      toolName: "read",
      input: { path: "README.md" },
    });
  assert.equal((await call("denied"))?.block, true);
  deny = false;
  await runtime.pause("task_resume");
  assert.equal((await call("cancelled"))?.block, true);
  await runtime.steer({ taskId: "task_resume", text: "resume" });
  assert.equal(await call("resumed"), undefined);
  await runtime.followUp({ taskId: "task_resume", text: "next" });
  assert.deepEqual(fixture.prompts, ["first", "resume", "next"]);
  assert.deepEqual(
    receipts.map((receipt) => [receipt.status, receipt.policyDecision]),
    [
      ["failed", "rejected"],
      ["failed", "rejected"],
    ],
  );
  await runtime.dispose();
});

test("native Bash waits for the correlated Host decision and attempt IDs survive runtime restarts", async () => {
  const receipts: ToolExecutionReceipt[] = [];
  for (const approved of [true, false]) {
    const fixture = createSessionFixture();
    const extensionFixture = createExtensionFixture();
    const events: Envelope[] = [];
    const host = new ResearchHost((event) => events.push(event));
    const runtime = new PiAgentRuntime({
      createSession: (async () => ({
        session: fixture.session,
        extensionsResult: { extensions: [] },
      })) as never,
      createSessionManager: () => sessionManagerFixture(),
      createResourceLoader: ({ extension }) => {
        void loadExtension(
          extensionFixture,
          typeof extension === "function" ? extension : extension.factory,
        );
        return extensionFixture.resourceLoader;
      },
      resolvePolicyDecision: async (_tool, _input, _taskId, signal) => {
        await host.authorize(
          {
            taskId: "task_wait",
            toolName: "bash",
            riskLevel: "privileged",
            inputDigest: "digest",
            inputJson: '{"command":"date"}',
            approvalId: "approval_fixture",
          },
          signal!,
        );
        return "approved";
      },
    });
    runtime.subscribe((event) => {
      if (event.kind === "tool.completed") receipts.push(event.receipt);
    });
    try {
      await runtime.startSession({ sessionId: "session_wait", cwd: "/tmp", tools: [] });
      await runtime.prompt({ taskId: "task_wait", text: "date" });
      let completed = false;
      const pending = extensionFixture.toolCall!({
        type: "tool_call",
        toolCallId: "same_call",
        toolName: "bash",
        input: { command: "date" },
      }).then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setImmediate(resolve));
      const operationId = events[0]!.requestId;
      host.acknowledge({ operationId: `${operationId}_confirmation`, ok: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completed, false, "notification ACK must not authorize a tool");
      host.acknowledge({ operationId, ok: approved, error: approved ? null : "用户拒绝" });
      const result = await pending;
      if (approved) {
        assert.equal(
          result,
          undefined,
          "the original Pi tool call continues, without another prompt",
        );
        await extensionFixture.toolEnd!({
          type: "tool_execution_end",
          toolCallId: "same_call",
          toolName: "bash",
          result: { content: [{ type: "text", text: "Fri Oct 23" }] },
          isError: false,
        });
      } else assert.equal(result?.block, true);
    } finally {
      await runtime.dispose();
      host.dispose();
    }
  }
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0]!.attemptId, receipts[1]!.attemptId);
  assert.deepEqual(
    receipts.map((receipt) => receipt.attemptNumber),
    [1, 1],
  );
  assert.deepEqual(
    receipts.map((receipt) => receipt.policyDecision),
    ["approved", "rejected"],
  );
});

test("verifies Pi native writes against the exact file postcondition", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "semi-os-pi-native-"));
  try {
    const fixture = createSessionFixture();
    const extensionFixture = createExtensionFixture();
    const receipts: ToolExecutionReceipt[] = [];
    const runtime = new PiAgentRuntime({
      createSession: (async () => ({
        session: fixture.session,
        extensionsResult: { extensions: [] },
      })) as never,
      createSessionManager: () => sessionManagerFixture(),
      createResourceLoader: ({ extension }) => {
        const factory = typeof extension === "function" ? extension : extension.factory;
        void loadExtension(extensionFixture, factory);
        return extensionFixture.resourceLoader;
      },
    });
    runtime.subscribe((event) => {
      if (event.kind === "tool.completed") {
        receipts.push(event.receipt);
      }
    });
    await runtime.startSession({
      sessionId: "session_product",
      cwd,
      tools: [],
    });
    await runtime.prompt({ taskId: "task_1", text: "write a note" });

    await extensionFixture.toolCall?.({
      type: "tool_call",
      toolCallId: "call_write",
      toolName: "write",
      input: { path: "note.txt", content: "verified content" },
    });
    await writeFile(join(cwd, "note.txt"), "verified content", "utf8");
    await extensionFixture.toolEnd?.({
      type: "tool_execution_end",
      toolCallId: "call_write",
      toolName: "write",
      result: { content: [{ type: "text", text: "Wrote note.txt" }] },
      isError: false,
    });

    assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "verified content");
    assert.equal(receipts[0]?.status, "succeeded");
    assert.equal(receipts[0]?.verification?.method, "filesystem_exact_postcondition");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restores the persisted Pi session referenced by a checkpoint", async () => {
  const fixture = createSessionFixture();
  const requestedCheckpoints: Array<AgentCheckpoint | undefined> = [];
  const runtime = new PiAgentRuntime({
    createSession: (async () => ({
      session: fixture.session,
      extensionsResult: { extensions: [] },
    })) as never,
    createSessionManager: ({ checkpoint }) => {
      requestedCheckpoints.push(checkpoint);
      return sessionManagerFixture(String(checkpoint?.data.runtimeSessionFile));
    },
    createResourceLoader: emptyResources,
  });
  const checkpoint: AgentCheckpoint = {
    sessionId: "session_product",
    sequence: 7,
    data: {
      runtime: "pi",
      runtimeSessionFile: "/tmp/semi-os/restored.jsonl",
    },
  };

  await runtime.startSession({
    sessionId: "session_product",
    cwd: "/tmp/semi-os",
    tools: [],
    checkpoint,
  });

  assert.equal(requestedCheckpoints[0], checkpoint);
  assert.equal((await runtime.checkpoint()).data.runtimeSessionFile, "/tmp/semi-os/restored.jsonl");
  assert.equal((await runtime.checkpoint()).sequence, 7);
});

test("official ResourceLoader replaces product identity and loads only built-in resources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "semi-os-product-context-"));
  const fixture = createSessionFixture();
  let loader!: ResourceLoader;
  try {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "untrusted"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "DEVELOPMENT_CONTEXT_MUST_NOT_LOAD");
    await writeFile(join(cwd, ".pi", "SYSTEM.md"), "DEVELOPMENT_SYSTEM_MUST_NOT_LOAD");
    await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "APPEND_MUST_NOT_LOAD");
    await writeFile(
      join(cwd, ".pi", "extensions", "untrusted.ts"),
      'throw new Error("must not execute");',
    );
    await writeFile(
      join(cwd, ".pi", "skills", "untrusted", "SKILL.md"),
      "---\nname: untrusted\ndescription: forbidden\n---\nForbidden",
    );
    const skills = new URL("../../skills/research", import.meta.url).pathname;
    const runtime = new PiAgentRuntime({
      systemPrompt: VOICE_SYSTEM_PROMPT,
      isolatedResources: true,
      additionalSkillPaths: [skills],
      createSession: (async (options) => {
        loader = options!.resourceLoader!;
        assert.equal(
          loader.getSystemPrompt(),
          VOICE_SYSTEM_PROMPT,
          "must be loaded before creating the session",
        );
        return { session: fixture.session, extensionsResult: loader.getExtensions() };
      }) as typeof createAgentSession,
      createSessionManager: () => sessionManagerFixture(),
    });
    await runtime.startSession({ sessionId: "session_product", cwd, tools: [] });
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(
      loader.getSkills().skills.map((skill) => skill.name),
      ["research"],
    );
    assert.equal(loader.getExtensions().extensions.length, 1, "Host policy extension is retained");
    assert.deepEqual(loader.getExtensions().errors, []);
    await runtime.prompt({ taskId: "task_1", text: "你好" });
    assert.deepEqual(fixture.prompts, ["你好"], "no system protocol appended to user messages");
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
