import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
    "#[allow(clippy::large_enum_variant)]",
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

/**
 * 协议校验器必须在构建期编译成普通函数模块。
 *
 * 运行期调用 `ajv.compile()` 会通过 `new Function` 生成校验代码，而桌面版 CSP
 * （`script-src 'self'`）禁止 eval：WKWebView 直接抛 EvalError，整个客户端白屏。
 * `pnpm dev` 看不到这个缺陷，因为 Vite dev server 不发送 CSP。这里改用 Ajv 的
 * standalone 代码生成，产物不含 `new Function`，浏览器/WebView 都能执行。
 */
const protocolRequire = createRequire(resolve(root, "packages/protocol/package.json"));
const { Ajv2020 } = protocolRequire("ajv/dist/2020.js");
const standaloneModule = protocolRequire("ajv/dist/standalone/index.js");
const standaloneCode = standaloneModule.default ?? standaloneModule;
const validatorAjv = new Ajv2020({
  strict: false,
  strictNumbers: true,
  allErrors: false,
  code: { source: true, esm: true },
});
const validatorRefs = {};
const validatorExports = {};
const exportOwner = new Map();

/**
 * 把 payload 里指向本地 $defs 的 `$ref` 改指向共享的 defs schema。
 *
 * 否则每个消息都会把整套 `$defs` 内联一份，生成的校验器会膨胀到数 MB；
 * 抽成独立 schema 后 Ajv 只生成一份复用的子校验器。
 */
const DEFS_ID = "urn:semi-os:defs";
function hoistDefs(node) {
  if (Array.isArray(node)) {
    return node.map(hoistDefs);
  }
  if (node && typeof node === "object") {
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] =
        key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")
          ? `${DEFS_ID}#${value.slice(1)}`
          : hoistDefs(value);
    }
    return result;
  }
  return node;
}

validatorAjv.addSchema({ $id: DEFS_ID, $defs: wireSchema.$defs });
for (const [direction, kinds] of Object.entries(messages)) {
  for (const [kind, payload] of Object.entries(kinds)) {
    const ref = `urn:semi-os:${direction}:${kind}`;
    // kind 可能带点号（如 desktop.result），导出名只能是合法标识符。
    const exportName = `${direction}_${kind}`.replace(/[^A-Za-z0-9_]/g, "_");
    if (exportOwner.has(exportName)) {
      throw new Error(
        `两个协议消息会导出同名校验器：${exportOwner.get(exportName)} 与 ${direction}:${kind}`,
      );
    }
    exportOwner.set(exportName, `${direction}:${kind}`);
    validatorAjv.addSchema({ $id: ref, ...hoistDefs(payload) });
    // standaloneCode 的映射是“导出名 → schema 引用”。
    validatorRefs[exportName] = ref;
    validatorExports[`${direction}:${kind}`] = exportName;
  }
}
/**
 * Ajv standalone 仍用 CJS 的 `require("ajv/dist/runtime/*").default` 引用运行时助手。
 * 生成物是 ESM（浏览器与 Node 直接用），所以要把这两处 require 换成静态 import。
 * 一旦 Ajv 升级引入新的 require 形式，这里会直接报错，避免静默生成坏包。
 */
function rewriteRuntimeRequires(code) {
  const aliases = new Map();
  const body = code.replace(/require\("([^"]+)"\)(\.default)?/g, (match, specifier, useDefault) => {
    if (!useDefault) {
      throw new Error(`standalone 产物出现未预期的 require 形式：${match}`);
    }
    if (!aliases.has(specifier)) {
      aliases.set(specifier, `__rt${aliases.size}`);
    }
    return aliases.get(specifier);
  });
  if (aliases.size === 0) {
    return { body, header: "" };
  }
  const imports = [...aliases].map(([specifier, alias]) => {
    const target = specifier.endsWith(".js") ? specifier : `${specifier}.js`;
    return `import * as ${alias}Ns from ${JSON.stringify(target)};`;
  });
  const bindings = [...aliases.values()].map(
    (alias) => `const ${alias} = runtimeExport(${alias}Ns);`,
  );
  return {
    body,
    header: [
      ...imports,
      // Node 里 namespace.default 是 module.exports（带 __esModule），Vite 会再包一层 default；
      // 两种形状都归一化到真正的函数值。
      "function runtimeExport(ns) {",
      "  const value = ns.default ?? ns;",
      '  return value && typeof value === "object" && "default" in value ? value.default : value;',
      "}",
      ...bindings,
    ].join("\n"),
  };
}

const runtimeRewritten = rewriteRuntimeRequires(standaloneCode(validatorAjv, validatorRefs));
const validatorsOutput = [
  // tsc 不去推断 Ajv standalone 产物（它会挂 .errors），只原样透传。
  "// @ts-nocheck",
  "// 由 scripts/generate-protocol.mjs 自动生成，请勿手动修改。",
  "// Ajv standalone 产物：普通函数而不是 new Function，运行期不需要 eval。",
  runtimeRewritten.header,
  runtimeRewritten.body,
  "export const protocolValidators = {",
  ...Object.entries(validatorExports).map(([key, name]) => `  ${JSON.stringify(key)}: ${name},`),
  "};\n",
].join("\n");

await mkdir(dirname(tsOutput), { recursive: true });
await mkdir(dirname(rustOutput), { recursive: true });
/**
 * 载荷是否允许 JSON null。
 *
 * 两种写法在 schema 里都合法：`type: ["object", "null"]` 与 `oneOf: [{type:"null"}, ...]`。
 * 只看前者会让 `browser.session.snapshot` 这类“无接管状态即为 null”的响应在 Rust 侧被拒，
 * Worker 因此进入重启循环。
 */
function payloadAllowsNull(payload) {
  if (Array.isArray(payload.type) && payload.type.includes("null")) {
    return true;
  }
  return (
    Array.isArray(payload.oneOf) && payload.oneOf.some((branch) => branch && branch.type === "null")
  );
}

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
  [resolve(root, "packages/protocol/src/generated/validators.generated.ts"), validatorsOutput],
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
            `        (${JSON.stringify(direction)}, ${JSON.stringify(kind)}) => Some(PayloadShape::${payloadAllowsNull(payload) ? "ObjectOrNull" : "Object"}),`,
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
