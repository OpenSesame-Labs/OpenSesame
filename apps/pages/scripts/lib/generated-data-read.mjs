import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync, transformSync } from "esbuild";
import {
  isJsonObject,
  isString,
} from "../../../../scripts/lib/json-boundary.mjs";

const root = fileURLToPath(new URL("../../../..", import.meta.url)).replace(
  /\/$/,
  "",
);

function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function assertPinnedSource(source, descriptor) {
  const actualHash = sourceHash(source);
  if (actualHash !== descriptor.hash) {
    throw new Error(
      `${descriptor.exportName} generated source pin mismatch: expected ${descriptor.hash}, received ${actualHash}`,
    );
  }
}

export function exportExpression(source, descriptor) {
  const exportStart = source.indexOf(`export const ${descriptor.exportName}`);
  const assignment = source.indexOf("=", exportStart);
  const end = source.lastIndexOf(";");
  if (exportStart < 0 || assignment < 0 || end <= assignment) {
    throw new Error(`${descriptor.exportName} static data boundary is missing`);
  }
  return {
    exportStart,
    assignment,
    expression: source.slice(assignment + 1, end).trim(),
  };
}

function unpackGeneratedJson(text, dictionary) {
  return text.replace(/~([0-9a-f]+)~/g, (_match, index) => {
    const value = dictionary[Number.parseInt(index, 16)];
    if (value === undefined) throw new Error("Invalid generated JSON fragment");
    return value;
  });
}

function readLiteralModuleData(source, descriptor) {
  const transpiled = transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    legalComments: "none",
  }).code;
  if (/^import\s/m.test(transpiled)) {
    throw new Error(
      `${descriptor.exportName} static data unexpectedly imports runtime code`,
    );
  }
  const executable = transpiled.replace(/export\s*\{[\s\S]*?\};\s*$/, "");
  if (executable === transpiled) {
    throw new Error(`${descriptor.exportName} static data exports are missing`);
  }
  const values = Function(
    `"use strict";${executable};return {${descriptor.exportNames.join(",")}};`,
  )();
  const roundTrip = JSON.parse(JSON.stringify(values));
  if (JSON.stringify(roundTrip) !== JSON.stringify(values)) {
    throw new Error(`${descriptor.exportName} static data is not JSON-safe`);
  }
  if (
    Object.keys(roundTrip).length !== descriptor.exportNames.length ||
    !descriptor.exportNames.every((name) => Object.hasOwn(roundTrip, name))
  ) {
    throw new Error(`${descriptor.exportName} static data export set drifted`);
  }
  return Object.freeze({ values: Object.freeze(roundTrip) });
}

function embeddedExpression(source, descriptor) {
  const declarationStart = source.indexOf(descriptor.declaration);
  const expressionStart = declarationStart + descriptor.declaration.length;
  const expressionEnd = source.indexOf(
    descriptor.expressionEnd,
    expressionStart,
  );
  if (declarationStart < 0 || expressionEnd <= expressionStart) {
    throw new Error(`${descriptor.exportName} embedded boundary is missing`);
  }
  return {
    declarationStart,
    expressionEnd,
    expression: source
      .slice(expressionStart, expressionEnd)
      .trim()
      .replace(/,\s*$/, ""),
  };
}

function embeddedBinding(source, name, descriptor) {
  const declaration = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=`).exec(
    source,
  );
  const end = declaration && source.indexOf(";", declaration.index);
  if (!declaration || end < 0) {
    throw new Error(
      `${descriptor.exportName} embedded binding ${name} is missing`,
    );
  }
  return source.slice(declaration.index, end + 1).replace(/^export\s+/, "");
}

function readEmbeddedArrayData(source, descriptor) {
  const { expression } = embeddedExpression(source, descriptor);
  const bindings = (descriptor.bindingNames ?? [])
    .map((name) => embeddedBinding(source, name, descriptor))
    .join("\n");
  const executable = transformSync(
    `${bindings}\nconst __opensesameDataValue = ${expression};`,
    {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      legalComments: "none",
    },
  ).code;
  const value = Function(
    `"use strict";${executable};return __opensesameDataValue;`,
  )();
  if (!Array.isArray(value)) {
    throw new Error(`${descriptor.exportName} static data is not an array`);
  }
  const roundTrip = JSON.parse(JSON.stringify(value));
  if (JSON.stringify(roundTrip) !== JSON.stringify(value)) {
    throw new Error(`${descriptor.exportName} static data is not JSON-safe`);
  }
  return Object.freeze({ value: Object.freeze(roundTrip) });
}

function readCapabilityCatalogData(descriptor) {
  for (const input of descriptor.sources) {
    const source = readFileSync(input.path, "utf8");
    assertPinnedSource(source, {
      ...descriptor,
      exportName: input.path,
      hash: input.hash,
    });
  }
  const capabilityRoot = `${root}/packages/app-core/src/lib/capabilities`;
  const entry = `
import { CORE_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-core.ts`)};
import { ALWAYS_ON_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-always-on.ts`)};
import { BROWSER_LOCAL_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-always-on-local.ts`)};
import { VAULT_FAMILY_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-optional-vault.ts`)};
import { IDENTITY_FAMILY_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-optional-identity.ts`)};
import { SERVICE_FAMILY_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-optional-services.ts`)};
import { PLUGIN_FAMILY_DESCRIPTORS } from ${JSON.stringify(`${capabilityRoot}/catalog-optional-plugins.ts`)};
export default [
  ...CORE_DESCRIPTORS,
  ...ALWAYS_ON_DESCRIPTORS,
  ...BROWSER_LOCAL_DESCRIPTORS,
  ...VAULT_FAMILY_DESCRIPTORS,
  ...IDENTITY_FAMILY_DESCRIPTORS,
  ...SERVICE_FAMILY_DESCRIPTORS,
  ...PLUGIN_FAMILY_DESCRIPTORS,
];`;
  const bundled = buildSync({
    stdin: { contents: entry, loader: "ts", resolveDir: root },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    write: false,
    logLevel: "silent",
  }).outputFiles[0]?.text;
  if (!bundled)
    throw new Error("Capability catalog extraction emitted no code");
  const bundledModule = { exports: {} };
  Function("module", "exports", bundled)(bundledModule, bundledModule.exports);
  const descriptors = bundledModule.exports.default;
  const json = JSON.stringify(descriptors);
  if (
    !Array.isArray(descriptors) ||
    sourceHash(json) !== descriptor.valueHash
  ) {
    throw new Error(
      `${descriptor.exportName} extracted value does not match its reviewed pin`,
    );
  }
  return Object.freeze({ descriptors: Object.freeze(descriptors) });
}

function readBundledExportData(descriptor) {
  for (const input of descriptor.sources) {
    assertPinnedSource(readFileSync(input.path, "utf8"), {
      ...descriptor,
      exportName: input.path,
      hash: input.hash,
    });
  }
  const entry = `export { ${descriptor.exportName} as default } from ${JSON.stringify(descriptor.path)};`;
  const bundled = buildSync({
    stdin: { contents: entry, loader: "ts", resolveDir: root },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    write: false,
    logLevel: "silent",
  }).outputFiles[0]?.text;
  if (!bundled)
    throw new Error(`${descriptor.exportName} extraction emitted no code`);
  const bundledModule = { exports: {} };
  Function("module", "exports", bundled)(bundledModule, bundledModule.exports);
  const value = bundledModule.exports.default;
  const roundTrip = JSON.parse(JSON.stringify(value));
  if (
    JSON.stringify(roundTrip) !== JSON.stringify(value) ||
    sourceHash(JSON.stringify(value)) !== descriptor.valueHash
  ) {
    throw new Error(
      `${descriptor.exportName} extracted value does not match its reviewed pin`,
    );
  }
  return Object.freeze({ value: Object.freeze(roundTrip) });
}

function readPackIndexData(source, descriptor) {
  const tailStart = source.indexOf("/** One dynamic import per pack");
  if (tailStart < 0) throw new Error("PACK_INDEX generated boundary drifted");
  return readLiteralModuleData(source.slice(0, tailStart), {
    ...descriptor,
    exportNames: [descriptor.exportName],
  });
}

function readLiteralArrayData(source, descriptor) {
  const { expression } = exportExpression(source, descriptor);
  const value = Function(`"use strict";return (${expression});`)();
  if (!Array.isArray(value)) {
    throw new Error(`${descriptor.exportName} static data is not an array`);
  }
  const roundTrip = JSON.parse(JSON.stringify(value));
  if (JSON.stringify(roundTrip) !== JSON.stringify(value)) {
    throw new Error(`${descriptor.exportName} static data is not JSON-safe`);
  }
  return Object.freeze({ value: Object.freeze(roundTrip) });
}

function readPackedStringData(source, descriptor) {
  const importLine =
    'import { unpackGeneratedJson } from "./generated-json.js";';
  const importStart = source.indexOf(importLine);
  if (importStart < 0) {
    throw new Error(`${descriptor.exportName} unpack import is missing`);
  }
  const executable = source
    .slice(importStart + importLine.length)
    .replace(
      `export const ${descriptor.exportName}`,
      `const ${descriptor.exportName}`,
    );
  const value = Function(
    "unpackGeneratedJson",
    `"use strict";${executable};return ${descriptor.exportName};`,
  )(unpackGeneratedJson);
  if (!isString(value)) {
    throw new Error(`${descriptor.exportName} generated data is not a string`);
  }
  JSON.parse(value);
  return Object.freeze({ value });
}

function readRowsData(source, descriptor) {
  const start = source.indexOf("const dictionary =");
  const end = source.indexOf(`export const ${descriptor.exportName}`);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `${descriptor.exportName} generated data boundary is missing`,
    );
  }
  const declaration = source
    .slice(start, end)
    .replace("const rows: readonly string[] =", "const rows =");
  const data = Function(
    `"use strict";${declaration};return { dictionary, rows };`,
  )();
  if (
    !isJsonObject(data) ||
    !Array.isArray(data.dictionary) ||
    !data.dictionary.every(isString) ||
    !Array.isArray(data.rows) ||
    !data.rows.every(isString)
  ) {
    throw new Error(
      `${descriptor.exportName} generated data is not string arrays`,
    );
  }
  return Object.freeze({
    dictionary: Object.freeze(data.dictionary),
    rows: Object.freeze(data.rows),
  });
}

/** Read reviewed literals from a source-hash-pinned generated/static module. */
export function readPackedGeneratedData(source, descriptor) {
  assertPinnedSource(source, descriptor);
  switch (descriptor.kind) {
    case "embedded-array":
      return readEmbeddedArrayData(source, descriptor);
    case "capability-catalog":
      return readCapabilityCatalogData(descriptor);
    case "bundled-export":
      return readBundledExportData(descriptor);
    case "json-default":
      return Object.freeze({ value: Object.freeze(JSON.parse(source)) });
    case "pack-index":
      return readPackIndexData(source, descriptor);
    case "literal-module":
      return readLiteralModuleData(source, descriptor);
    case "literal-array":
      return readLiteralArrayData(source, descriptor);
    case "packed-string":
      return readPackedStringData(source, descriptor);
    default:
      return readRowsData(source, descriptor);
  }
}
