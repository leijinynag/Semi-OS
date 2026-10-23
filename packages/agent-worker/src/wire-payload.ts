import { ProtocolValidationError, type JsonValue } from "@semi-os/protocol";

/**
 * 领域事件允许未设置的可选属性；IPC 只接受明确的 JSON 值。
 * 仅省略对象中的 undefined，不把 NaN、循环引用或特殊对象静默转换成合法数据。
 */
export function toWirePayload(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ProtocolValidationError("Invalid domain event JSON value", "invalid_payload");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // 数组空位或 undefined 不能省略，否则会改变数据的位置语义。
      return Array.from(value, (entry) => toWirePayload(entry, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toWirePayload(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}
