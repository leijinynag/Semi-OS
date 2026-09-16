import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * protocol.schema.json 是跨 TypeScript/Rust 领域类型的单一事实来源。
 *
 * 生成器刻意只依赖 Node 标准库，保证仓库刚完成依赖安装时即可运行。
 * 不要直接编辑生成文件；新增 ID 或枚举时先修改 Schema，再执行
 * `pnpm run generate:protocol` 并运行两端契约测试。
 */
const root = resolve(new URL("..", import.meta.url).pathname);
const schemaPath = resolve(root, "schemas/protocol.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const definitions = schema.$defs;

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
  'export type Brand<T, B extends string> = T & { readonly __brand: B };',
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
    "#[serde(rename_all = \"snake_case\")]",
    `pub enum ${typeName} {`,
  );
  for (const value of definition.enum) {
    rustLines.push(`    ${rustVariantName(value)},`);
  }
  rustLines.push("}", "");
}

const tsOutput = resolve(
  root,
  "packages/shared/src/generated/domain.generated.ts",
);
const rustOutput = resolve(root, "crates/protocol/src/generated.rs");

await mkdir(dirname(tsOutput), { recursive: true });
await mkdir(dirname(rustOutput), { recursive: true });
await writeFile(tsOutput, `${tsLines.join("\n")}\n`);
await writeFile(rustOutput, `${rustLines.join("\n")}`);
