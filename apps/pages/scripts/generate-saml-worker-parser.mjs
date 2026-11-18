import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod/mini";
import { isString } from "../../../packages/os-domain/src/json.ts";

const output = fileURLToPath(
  new URL("../src/sw/saml-command.generated.ts", import.meta.url),
);
const require = createRequire(import.meta.url);
const lengthCondition = z.minLength(0)._zod.def.when;

function requireCondition(condition, reason) {
  if (!condition) throw new Error(`Unsupported SAML worker schema: ${reason}`);
}

function allowKeys(value, allowed, reason) {
  requireCondition(
    Object.getOwnPropertySymbols(value).length === 0 &&
      Object.getOwnPropertyNames(value).every((key) => allowed.includes(key)),
    reason,
  );
}

function renderStringCheck(check, field, value, statements) {
  const item = check._zod.def;
  if (item.check === "string_format" && item.format === "regex") {
    allowKeys(item, ["check", "format", "pattern"], field);
    requireCondition(
      item.pattern instanceof RegExp && item.pattern.flags === "",
      `${field} regex`,
    );
    statements.push(
      `if (!${item.pattern.toString()}.test(${value})) return null;`,
    );
    return;
  }
  if (item.check === "min_length" || item.check === "max_length") {
    const min = item.check === "min_length";
    allowKeys(item, ["check", min ? "minimum" : "maximum", "when"], field);
    const limit = min ? item.minimum : item.maximum;
    requireCondition(
      Number.isSafeInteger(limit) &&
        limit >= 0 &&
        item.when === lengthCondition,
      `${field} length`,
    );
    statements.push(
      `if (${value}.length ${min ? "<" : ">"} ${limit}) return null;`,
    );
    return;
  }
  throw new Error(`Unsupported SAML worker schema: ${field} string check`);
}

function renderString(def, field, path, statements) {
  allowKeys(def, ["type", "checks", "format", "check", "abort"], field);
  requireCondition(
    def.format === undefined ||
      (def.format === "url" &&
        def.check === "string_format" &&
        def.abort === false),
    `${field} string format`,
  );
  statements.push(`if (!isString(${path})) return null;`);
  let value = path;
  if (def.format === "url") {
    const local = `url${statements.length}`;
    statements.push(`let ${local} = ${path}.trim();`);
    statements.push(`try { new URL(${local}); } catch { return null; }`);
    statements.push(`${local} = ${local}.replace(/[\\t\\n\\r]/g, "");`);
    value = local;
  }
  for (const check of def.checks ?? [])
    renderStringCheck(check, field, value, statements);
  return value;
}

function renderNumber(def, field, path, statements) {
  allowKeys(def, ["type", "check", "abort", "format", "checks"], field);
  requireCondition(
    def.check === "number_format" &&
      def.format === "safeint" &&
      def.abort === false,
    `${field} number`,
  );
  statements.push(
    `if (!isNumber(${path}) || !Number.isSafeInteger(${path})) return null;`,
  );
  for (const check of def.checks ?? []) {
    const item = check._zod.def;
    allowKeys(item, ["check", "value", "inclusive"], field);
    requireCondition(
      item.check === "greater_than" &&
        item.inclusive === false &&
        Number.isFinite(item.value),
      `${field} number check`,
    );
    statements.push(
      `if (${path} <= ${JSON.stringify(item.value)}) return null;`,
    );
  }
  return path;
}

function renderField(schema, field, statements) {
  requireCondition(field !== "__proto__", "unsafe object key");
  const def = schema._zod.def;
  const path = /^[A-Za-z_$][\w$]*$/.test(field)
    ? `value.${field}`
    : `value[${JSON.stringify(field)}]`;
  if (def.type === "literal") {
    allowKeys(def, ["type", "values"], field);
    requireCondition(
      def.values.length === 1 && isString(def.values[0]),
      `${field} literal`,
    );
    statements.push(
      `if (${path} !== ${JSON.stringify(def.values[0])}) return null;`,
    );
    return path;
  }
  if (def.type === "enum") {
    allowKeys(def, ["type", "entries"], field);
    const values = Object.values(def.entries);
    requireCondition(
      values.length > 0 && values.every(isString),
      `${field} enum`,
    );
    statements.push(
      `if (${values.map((item) => `${path} !== ${JSON.stringify(item)}`).join(" && ")}) return null;`,
    );
    return path;
  }
  if (def.type === "string") return renderString(def, field, path, statements);
  if (def.type === "number") return renderNumber(def, field, path, statements);
  throw new Error(`Unsupported SAML worker schema: ${field} type`);
}

function renderBranch(schema, index) {
  const def = schema._zod.def;
  allowKeys(def, ["type", "shape", "catchall"], `branch ${index}`);
  requireCondition(
    def.type === "object" && def.catchall?._zod.def.type === "never",
    `branch ${index} strict object`,
  );
  allowKeys(def.catchall._zod.def, ["type"], `branch ${index} catchall`);
  const properties = Object.entries(def).find(([key]) => key === "shape")?.[1];
  requireCondition(properties !== undefined, `branch ${index} fields`);
  requireCondition(
    Object.getOwnPropertySymbols(properties).length === 0,
    `branch ${index} symbols`,
  );
  const fields = Object.entries(properties);
  const statements = [
    `if (!strict(value, ${JSON.stringify(fields.map(([key]) => key))})) return null;`,
  ];
  const output = fields.map(
    ([field, item]) =>
      `${JSON.stringify(field)}: ${renderField(item, field, statements)}`,
  );
  return `function branch${index}(value: JsonObject): SamlPostCommand | null {\n${statements.join("\n")}\nreturn { ${output.join(", ")} };\n}`;
}

/** Compile only the supported Zod subset; an unknown construct stops generation. */
export function renderSamlWorkerParser(
  schema,
  bytes,
  { sourceHash, zodVersion },
) {
  requireCondition(Number.isSafeInteger(bytes) && bytes > 0, "byte limit");
  requireCondition(
    /^[a-f0-9]{64}$/.test(sourceHash) &&
      /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(zodVersion),
    "input fingerprint",
  );
  const def = schema._zod.def;
  allowKeys(def, ["type", "options"], "union");
  requireCondition(
    def.type === "union" &&
      Array.isArray(def.options) &&
      def.options.length > 0,
    "union",
  );
  const branches = def.options.map(renderBranch);
  return `// Generated by apps/pages/scripts/generate-saml-worker-parser.mjs; do not edit.\n// SAML_SCHEMA_SHA256: ${sourceHash}\n// SAML_ZOD_VERSION: ${zodVersion}\n\nimport type { SamlPostCommandSchema } from "@opensesame/app-core/browser/saml/post-wire.js";\nimport { type BoundaryValue, type JsonObject, isJsonObject, isNumber, isString } from "@opensesame/os-domain";\nimport type { z } from "zod/mini";\nexport const SAML_POST_BYTES = ${bytes};\nexport type SamlPostCommand = z.infer<typeof SamlPostCommandSchema>;\nfunction strict(value: JsonObject, allowed: readonly string[]): boolean {\nfor (const key in value) if (!allowed.includes(key)) return false;\nreturn true;\n}\n${branches.join("\n")}\nexport function parseSamlPostCommand(value: BoundaryValue): SamlPostCommand | null {\nif (!isJsonObject(value)) return null;\nreturn ${branches.map((_, index) => `branch${index}(value)`).join(" ?? ")};\n}\n`;
}

export function formatSamlWorkerParser(schema, bytes, inputs) {
  return execFileSync(
    process.execPath,
    [
      require.resolve("@biomejs/biome/bin/biome"),
      "format",
      "--stdin-file-path",
      output,
    ],
    { input: renderSamlWorkerParser(schema, bytes, inputs), encoding: "utf8" },
  );
}
