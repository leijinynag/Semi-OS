import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { format, resolveConfig } from "prettier";

/**
 * protocol.schema.json 是跨 TypeScript/Rust 领域类型的单一事实来源。
 *
 * 生成器使用仓库统一的格式化工具，保证生成检查不会与格式检查互相制造漂移。
 * 不要直接编辑生成文件；新增 ID 或枚举时先修改 Schema，再执行
 * `pnpm run generate:protocol` 并运行两端契约测试。
 */
const root = resolve(new URL("..", import.meta.url).pathname);
const schemaPath = resolve(root, "schemas/protocol.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const definitions = schema.$defs;
const messages = schema["x-messages"];
const prettierOptions = (await resolveConfig(resolve(root, ".prettierrc.json"))) ?? {};

// 同一份字段定义生成判别联合和校验器输入，禁止维护第二份 kind 白名单。
function tsType(node) {
  if (node.$ref) return tsType(definitions[node.$ref.split("/").at(-1)]);
  if ("const" in node) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((entry) => JSON.stringify(entry)).join(" | ");
  if (node.oneOf) {
    const { oneOf, ...parent } = node;
    return oneOf
      .map((branch) =>
        tsType({
          ...parent,
          ...branch,
          properties: { ...parent.properties, ...branch.properties },
          required: [...new Set([...(parent.required ?? []), ...(branch.required ?? [])])],
        }),
      )
      .join(" | ");
  }
  if (Array.isArray(node.type))
    return node.type.map((type) => tsType({ ...node, type })).join(" | ");
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsType(node.items)}>`;
    case "object": {
      const fields = Object.entries(node.properties ?? {}).map(
        ([key, value]) =>
          `${JSON.stringify(key)}${node.required?.includes(key) ? "" : "?"}: ${tsType(value)}`,
      );
      if (typeof node.additionalProperties === "object")
        fields.push(`[key: string]: ${tsType(node.additionalProperties)}`);
      return fields.length ? `{ ${fields.join("; ")} }` : "{ [key: string]: JsonValue }";
    }
    default:
      return "JsonValue";
  }
}
const messageTypes = [
  "// 自动生成；协议字段和消息方向只在 protocol.schema.json 中维护。",
  'import type { EnvelopeContext, JsonValue } from "../envelope.ts";',
  'import type { RequestId } from "@semi-os/shared";',
];
const payloadRust = [
  "// 自动生成；先校验 wire schema，再解码对应 DTO。",
  "use serde::{Deserialize, Serialize};",
];
const rustNames = new Set();
const rustKeywords = new Set(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
    " ",
  ),
);
function rustPayloadType(node, name) {
  if (node.$ref) {
    const key = node.$ref.split("/").at(-1);
    return rustPayloadType(definitions[key], `Payload${key[0].toUpperCase()}${key.slice(1)}`);
  }
  if (node.oneOf) {
    if (!rustNames.has(name)) {
      rustNames.add(name);
      const { oneOf, ...parent } = node;
      const variants = oneOf.map((branch, index) => {
        const child = {
          ...parent,
          ...branch,
          properties: { ...parent.properties, ...branch.properties },
          required: [...new Set([...(parent.required ?? []), ...(branch.required ?? [])])],
        };
        return `    Variant${index}(${rustPayloadType(child, `${name}Variant${index}`)}),`;
      });
      // 子类型由递归追加；父类型在字段齐备后一次写出，防止嵌套 struct。
      payloadRust.push(
        "#[derive(Debug, Clone, Serialize, Deserialize)]",
        "#[serde(untagged)]",
        `pub enum ${name} {`,
        ...variants,
        "}",
      );
    }
    return name;
  }
  if (Array.isArray(node.type)) {
    if (node.type.includes("null") && node.type.length === 2)
      return `Option<${rustPayloadType({ ...node, type: node.type.find((type) => type !== "null") }, name)}>`;
    return "serde_json::Value";
  }
  const type =
    node.type ??
    (node.properties
      ? "object"
      : node.enum
        ? typeof node.enum[0]
        : "const" in node
          ? typeof node.const
          : undefined);
  switch (type) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      return node.minimum >= 0 ? "u64" : "i64";
    case "number":
      return "f64";
    case "array":
      return `Vec<${rustPayloadType(node.items, `${name}Item`)}>`;
    case "object": {
      const entries = Object.entries(node.properties ?? {});
      if (!entries.length)
        return `std::collections::BTreeMap<String, ${typeof node.additionalProperties === "object" ? rustPayloadType(node.additionalProperties, `${name}Entry`) : "serde_json::Value"}>`;
      if (!rustNames.has(name)) {
        rustNames.add(name);
        const fields = entries.map(([key, value]) => {
          const field = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
          const type = rustPayloadType(value, `${name}${key[0].toUpperCase()}${key.slice(1)}`);
          const optional = !node.required?.includes(key);
          return `${optional ? '    #[serde(default, skip_serializing_if = "Option::is_none")]\n' : ""}    pub ${rustKeywords.has(field) ? `r#${field}` : field}: ${optional ? `Option<${type}>` : type},`;
        });
        payloadRust.push(
          "#[derive(Debug, Clone, Serialize, Deserialize)]",
          '#[serde(rename_all = "camelCase")]',
          `pub struct ${name} {`,
          ...fields,
          "}",
        );
      }
      return name;
    }
    default:
      return "serde_json::Value";
  }
}
for (const [direction, kinds] of Object.entries(messages)) {
  const name = direction[0].toUpperCase() + direction.slice(1);
  messageTypes.push(`export type ${name}Payloads = {`);
  for (const [kind, payload] of Object.entries(kinds)) {
    messageTypes.push(`${JSON.stringify(kind)}: ${tsType(payload)};`);
  }
  messageTypes.push(
    "};",
    `export type ${name}Message = { [K in keyof ${name}Payloads]: EnvelopeContext & {`,
    `protocolVersion: 1; requestId: RequestId; direction: "${direction}"; kind: K; payload: ${name}Payloads[K]`,
    `} }[keyof ${name}Payloads];`,
  );
  const variants = Object.entries(kinds).map(([kind, payload]) => {
    const variant = kind
      .split(/[._]/)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
    return `    #[serde(rename = ${JSON.stringify(kind)})]\n    ${variant}(${rustPayloadType(payload, `${name}${variant}Payload`)}),`;
  });
  payloadRust.push(
    "#[derive(Debug, Clone, Serialize, Deserialize)]",
    '#[serde(tag = "kind", content = "payload")]',
    `pub enum ${name}Message {`,
    ...variants,
    "}",
  );
}
messageTypes.push(
  "export type ValidatedMessage = RequestMessage | ResponseMessage | EventMessage | ErrorMessage;",
);
const wireSchema = {
  ...schema,
  oneOf: Object.entries(messages).flatMap(([direction, kinds]) =>
    Object.entries(kinds).map(([kind, payload]) => ({
      properties: { direction: { const: direction }, kind: { const: kind }, payload },
    })),
  ),
};
delete wireSchema["x-messages"];

// x-semi-os-type 是代码生成标记，普通 JSON Schema 校验器会安全忽略它。
const idDefinitions = Object.values(definitions).filter(
  (definition) => definition["x-semi-os-type"] && definition.pattern,
);
const enumDefinitions = Object.values(definitions).filter(
  (definition) => definition["x-semi-os-type"] && definition.enum,
);

const tsLines = [
  "// 由 scripts/generate-protocol.mjs 自动生成，请勿手动修改。",
  "// 修改类型时请编辑 schemas/protocol.schema.json 后重新生成。",
  "",
  "export type Brand<T, B extends string> = T & { readonly __brand: B };",
  "",
];

for (const definition of idDefinitions) {
  const typeName = definition["x-semi-os-type"];
  tsLines.push(`export type ${typeName} = Brand<string, "${typeName}">;`);
}

for (const definition of enumDefinitions) {
  const typeName = definition["x-semi-os-type"];
  tsLines.push(
    `export type ${typeName} = ${definition.enum
      .map((value) => JSON.stringify(value))
      .join(" | ")};`,
  );
  tsLines.push("");
}

const rustLines = [
  "// 由 scripts/generate-protocol.mjs 自动生成，请勿手动修改。",
  "// 修改类型时请编辑 schemas/protocol.schema.json 后重新生成。",
  "",
  "use serde::{Deserialize, Serialize};",
  "",
];

for (const definition of idDefinitions) {
  const typeName = definition["x-semi-os-type"];
  rustLines.push(
    "#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]",
    `pub struct ${typeName}(pub String);`,
    "",
  );
}

const rustVariantName = (value) =>
  value
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

for (const definition of enumDefinitions) {
  const typeName = definition["x-semi-os-type"];
  rustLines.push(
    "#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]",
    '#[serde(rename_all = "snake_case")]',
    `pub enum ${typeName} {`,
  );
  for (const value of definition.enum) {
    rustLines.push(`    ${rustVariantName(value)},`);
  }
  rustLines.push("}", "");
}

const tsOutput = resolve(root, "packages/shared/src/generated/domain.generated.ts");
const rustOutput = resolve(root, "crates/protocol/src/generated.rs");

await mkdir(dirname(tsOutput), { recursive: true });
await mkdir(dirname(rustOutput), { recursive: true });
const outputs = [
  [tsOutput, `${tsLines.join("\n")}\n`],
  [rustOutput, `${rustLines.join("\n")}`],
  [
    resolve(root, "packages/protocol/src/generated/messages.generated.ts"),
    `${messageTypes.join("\n")}\n`,
  ],
  [
    resolve(root, "packages/protocol/src/generated/schema.generated.ts"),
    `// 自动生成；供运行时校验使用。\nexport const wireSchema = ${JSON.stringify(wireSchema)} as const;\nexport const messageSchemas = ${JSON.stringify(messages)} as const;\n`,
  ],
  [
    resolve(root, "crates/protocol/src/wire.schema.generated.json"),
    `${JSON.stringify(wireSchema, null, 2)}\n`,
  ],
  [resolve(root, "crates/protocol/src/messages.generated.rs"), `${payloadRust.join("\n")}\n`],
  [
    resolve(root, "crates/protocol/src/registry.generated.rs"),
    `// 自动生成；不能另写跨进程消息白名单。\nfn registered_message_shape(direction: &str, kind: &str) -> Option<PayloadShape> {\n    match (direction, kind) {\n${Object.entries(
      messages,
    )
      .flatMap(([direction, kinds]) =>
        Object.entries(kinds).map(
          ([kind, payload]) =>
            `        (${JSON.stringify(direction)}, ${JSON.stringify(kind)}) => Some(PayloadShape::${Array.isArray(payload.type) && payload.type.includes("null") ? "ObjectOrNull" : "Object"}),`,
        ),
      )
      .join("\n")}\n        _ => None,\n    }\n}\n`,
  ],
];
for (const [path, rawContents] of outputs) {
  // 生成器与 cargo fmt 必须产生相同字节，否则检查和格式化会相互制造漂移。
  const contents = path.endsWith(".rs")
    ? execFileSync("rustfmt", ["--edition", "2021"], { input: rawContents }).toString()
    : path.endsWith(".json")
      ? await format(rawContents, { ...prettierOptions, parser: "json" })
      : rawContents;
  await mkdir(dirname(path), { recursive: true });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8").catch(() => "")) !== contents) {
      throw new Error(`Generated protocol is stale: ${path}`);
    }
  } else await writeFile(path, contents);
}
