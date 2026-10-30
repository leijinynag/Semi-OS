import type { JsonObject, ToolDefinition, ToolExecutionResult } from "@semi-os/tool-sdk";
import { LarkService } from "./lark-service.ts";

const property = { type: "string", minLength: 1 };
const readContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: false, freshness: "best_effort" },
  mutation: { kind: "none", atomic: true },
  verification: { required: true, method: "tool" },
  reversibility: "reversible",
  idempotency: "idempotent",
  reconciliation: "safe",
};
const sendContract: NonNullable<ToolDefinition["contract"]> = {
  observation: { required: true, freshness: "best_effort" },
  mutation: { kind: "external", atomic: true },
  verification: { required: true, method: "tool" },
  reversibility: "irreversible",
  idempotency: "keyed",
  reconciliation: "required",
};

function schema(properties: JsonObject, required: readonly string[]): JsonObject {
  return { type: "object", properties, required, additionalProperties: false };
}

function textOutput(result: unknown, summary: string): ToolExecutionResult {
  return {
    output: result && typeof result === "object" ? (result as JsonObject) : { result },
    outputSummary: summary,
  };
}

async function verifyRead(_input: JsonObject, result: ToolExecutionResult) {
  return {
    status: result.output.error ? ("inconclusive" as const) : ("passed" as const),
    method: "lark_cli_readback",
    summary: result.output.error ? String(result.output.error) : result.outputSummary,
    evidence: [{ kind: "lark_cli", reference: "structured-json" }],
  };
}

export function createLarkTools(lark: LarkService): ToolDefinition[] {
  return [
    {
      name: "lark_search_docs",
      description:
        "Search Lark documents with a bounded query; returns metadata and snippets, not authorization.",
      riskLevel: "read",
      requiredCapabilities: ["cli.lark"],
      contract: readContract,
      inputSchema: schema(
        { query: property, pageSize: { type: "integer", minimum: 1, maximum: 20 } },
        ["query"],
      ),
      execute: async (input, context) =>
        textOutput(
          await lark.searchDocs(String(input.query), context.signal, Number(input.pageSize ?? 15)),
          "Lark document search completed",
        ),
      verify: verifyRead,
    },
    {
      name: "lark_read_doc",
      description: "Read one explicitly selected Lark document by token or URL.",
      riskLevel: "read",
      requiredCapabilities: ["cli.lark"],
      contract: readContract,
      inputSchema: schema({ doc: property }, ["doc"]),
      execute: async (input, context) =>
        textOutput(
          await lark.fetchDoc(String(input.doc), context.signal),
          "Lark document read completed",
        ),
      verify: verifyRead,
    },
    {
      name: "lark_list_chats",
      description: "List bounded Lark user and group conversations to resolve an exact recipient.",
      riskLevel: "read",
      requiredCapabilities: ["cli.lark"],
      contract: readContract,
      inputSchema: schema({ pageSize: { type: "integer", minimum: 1, maximum: 20 } }, []),
      execute: async (input, context) =>
        textOutput(
          await lark.listChats(context.signal, Number(input.pageSize ?? 20)),
          "Lark chats listed",
        ),
      verify: verifyRead,
    },
    {
      name: "lark_list_messages",
      description:
        "Read recent messages from one exact Lark chat for confirmation or reconciliation.",
      riskLevel: "read",
      requiredCapabilities: ["cli.lark"],
      contract: readContract,
      inputSchema: schema({ chatId: property }, ["chatId"]),
      execute: async (input, context) =>
        textOutput(
          await lark.listChatMessages(String(input.chatId), context.signal),
          "Lark chat messages read",
        ),
      verify: verifyRead,
    },
    {
      name: "lark_send_message",
      description:
        "Send one exact text message to one exact Lark chat or user. Host confirmation must bind the full recipient and text; uncertain sends are not retried.",
      riskLevel: "external_side_effect",
      requiredCapabilities: ["cli.lark"],
      contract: sendContract,
      inputSchema: schema(
        {
          chatId: property,
          userId: property,
          text: { type: "string", minLength: 1, maxLength: 20_000 },
        },
        ["text"],
      ),
      execute: async (input, context) => {
        const result = await lark.sendMessage(
          {
            chatId: typeof input.chatId === "string" ? input.chatId : undefined,
            userId: typeof input.userId === "string" ? input.userId : undefined,
            text: String(input.text),
            idempotencyKey: context.idempotencyKey,
          },
          context.signal,
        );
        return textOutput(result, "Lark message sent or reconciled");
      },
      verify: async (_input, result) => ({
        status:
          result.output.status === "reconciled" ||
          result.output.message_id ||
          result.output.messageId
            ? "passed"
            : "inconclusive",
        method: "lark_message_readback",
        summary: result.outputSummary,
        evidence: [
          {
            kind: "lark_message",
            reference: String(result.output.message_id ?? result.output.messageId ?? "reconciled"),
          },
        ],
      }),
    },
  ];
}
