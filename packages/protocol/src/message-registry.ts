import { Ajv2020 } from "ajv/dist/2020.js";
import { ProtocolValidationError, type JsonValue } from "./envelope.ts";
import { messageSchemas, wireSchema } from "./generated/schema.generated.ts";
export type {
  RequestMessage,
  ResponseMessage,
  EventMessage,
  ValidatedMessage,
} from "./generated/messages.generated.ts";

/** Schema 生成的注册表同时约束方向与字段；领域状态机仍负责业务不变量。 */
export const PROTOCOL_MESSAGE_REGISTRY = messageSchemas;
type Registry = typeof messageSchemas;
export type ProtocolDirection = keyof Registry;
export type ProtocolKind<D extends ProtocolDirection = ProtocolDirection> = keyof Registry[D] &
  string;
export type ProtocolPayloadShape<
  D extends ProtocolDirection,
  K extends ProtocolKind<D>,
> = Registry[D][K];

const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false });
const validators = new Map(
  Object.entries(messageSchemas).flatMap(([direction, kinds]) =>
    Object.entries(kinds).map(
      ([kind, payload]) =>
        [`${direction}:${kind}`, ajv.compile({ $defs: wireSchema.$defs, ...payload })] as const,
    ),
  ),
);

/** 拒绝无法无损穿过 JSONL 的值；Schema 的扩展字段也不能夹带非 JSON 数据。 */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new ProtocolValidationError(
      "Payload must contain finite, acyclic JSON values",
      "invalid_payload",
    );
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new ProtocolValidationError("Payload must contain plain JSON objects", "invalid_payload");
  }
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    assertJson(entry, ancestors);
  ancestors.delete(value);
}

export function isProtocolKind(
  direction: ProtocolDirection,
  kind: string,
): kind is ProtocolKind<typeof direction> {
  return Object.hasOwn(messageSchemas[direction], kind);
}

/** 不回显输入或校验器原始数据，防止音频、凭证及工具输入泄露到日志。 */
export function assertRegisteredMessage(
  direction: ProtocolDirection,
  kind: string,
  payload: unknown,
): asserts payload is JsonValue {
  const validate = validators.get(`${direction}:${kind}`);
  if (!validate) {
    throw new ProtocolValidationError(
      `Unsupported ${direction} message kind: ${kind}`,
      "unsupported_kind",
    );
  }
  assertJson(payload);
  if (!validate(payload)) {
    const error = validate.errors?.[0];
    throw new ProtocolValidationError(
      `Invalid ${kind} payload at ${error?.instancePath || "/"} (${error?.keyword ?? "schema"})`,
      "invalid_payload",
    );
  }
}
