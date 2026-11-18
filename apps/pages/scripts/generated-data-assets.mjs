import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync, transformSync } from "esbuild";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(
  /\/$/,
  "",
);

const capabilityCatalogSources = Object.freeze(
  [
    [
      "catalog.ts",
      "5e06772959641616118a5e78eb426997f722b6a945bd95ada6cff0e877dee7ac",
    ],
    [
      "descriptor.ts",
      "10b341d43f39b1ad8361840f1456b72cace056cb4c2fc740f2d174d475bb4ab1",
    ],
    [
      "catalog-core.ts",
      "32d70fa62a431e8803162e16cd6091dd15afe5fc28440eb358b1e0551f559e9c",
    ],
    [
      "catalog-always-on.ts",
      "a453a99f0258b5d7b50d0a430509f306c9741386a48bc2b220fb339940143c86",
    ],
    [
      "catalog-always-on-local.ts",
      "a607e14063df7b610de6d4b46f853a2979eabccf991ae731cd8ce2c2107c39d7",
    ],
    [
      "catalog-optional-vault.ts",
      "81452e9111a9db7ce304f51b821600b14826d4ce11c528125bb2b2aca16e5972",
    ],
    [
      "catalog-optional-identity.ts",
      "ffc64484d56453b4042d45683b199aef9d51f7a7a5fc455b4ec0ee3de2cd9c3f",
    ],
    [
      "catalog-optional-services.ts",
      "110cfb254f59fc849d578c5c7f7cf0ec1e5e753f100984167f0fb0fca4608ff1",
    ],
    [
      "catalog-optional-plugins.ts",
      "ba3317f06ea778ae3be1f00a40a927715b84e243f3ba2f4525bd7f301b9b045f",
    ],
  ].map(([file, hash]) => ({
    path: `${root}/packages/app-core/src/lib/capabilities/${file}`,
    hash,
  })),
);

const capabilityCatalogDescriptor = Object.freeze({
  kind: "capability-catalog",
  path: capabilityCatalogSources[0].path,
  hash: capabilityCatalogSources[0].hash,
  exportName: "CAPABILITY_CATALOG",
  assetName: "generated-data/capability-catalog.json",
  sources: capabilityCatalogSources,
  valueHash: "1d4590233e0e826e47b91bd3bc0da02d2a79f3706d0117a35a5869ed9f868e6d",
});

const capabilityTutorialDescriptor = Object.freeze({
  kind: "bundled-export",
  path: `${root}/packages/app-core/src/tutorial/registry/capability-tutorials.ts`,
  hash: "714555a12f22bfeeb12e59ef27d0356a6a336e157fdb85cf1c957d24d9a290c3",
  exportName: "CAPABILITY_TUTORIALS",
  assetName: "generated-data/capability-tutorials.json",
  sources: [
    {
      path: `${root}/packages/app-core/src/tutorial/registry/capability-tutorials.ts`,
      hash: "714555a12f22bfeeb12e59ef27d0356a6a336e157fdb85cf1c957d24d9a290c3",
    },
    {
      path: `${root}/packages/app-core/src/tutorial/registry/authority-help.ts`,
      hash: "1d71b7f71ea0eeee824646c8046970822ab959221948589403b393297d89de5a",
    },
  ],
  valueHash: "5e949fc2903db2f7881705fef07edcc27b548431a8b3028b1e53a09df9e57ac5",
});

function tutorialDataModule(file, hash, exportNames) {
  return {
    kind: "literal-module",
    path: `${root}/packages/app-core/src/tutorial/registry/${file}.ts`,
    hash,
    exportName: exportNames[0],
    exportNames,
    assetName: `generated-data/tutorial-${file}.json`,
  };
}

const generatedModules = Object.freeze([
  capabilityCatalogDescriptor,
  capabilityTutorialDescriptor,
  {
    kind: "json-default",
    path: `${root}/packages/capability-registry/pwa-summaries.json`,
    hash: "cf8c3ddb5dabcf753b719373a65b0a164e2904735e16cdb0c19cfffa5a1114cc",
    exportName: "default",
    assetName: "generated-data/pwa-capability-summaries.json",
    specifier: "@opensesame/capability-registry/pwa-summaries.json",
  },
  {
    kind: "pack-index",
    path: `${root}/packages/vault-item-types/src/packs.generated.ts`,
    hash: "328141d7cea006bb4877f90165b0fe3d54ac23408268fd27c7d32e1a90629ca8",
    exportName: "PACK_INDEX",
    assetName: "generated-data/vault-item-pack-index.json",
  },
  {
    kind: "literal-module",
    path: `${root}/packages/vault-item-types/src/definitions.generated.ts`,
    hash: "1f18af08e2692ff2e45cbd8e8d90981f633a884cb063d1580c716d62272f546b",
    exportName: "BUILTIN_DEFINITION_JSON",
    exportNames: ["BUILTIN_DEFINITION_JSON"],
    assetName: "generated-data/vault-item-core-definitions.json",
  },
  ...[
    [
      "spec/log-scrub/log-scrub.json",
      "491f70a2e2ca25982abee7d24d965d1a5877e9f708e1d7f11a59804d52ca4644",
    ],
    [
      "spec/conformance/password-policy.json",
      "15af4f0ede3f997dec01718b52bbfda87e4f4f2d2ba4735a7112301803dc0f08",
    ],
    [
      "spec/conformance/retired-retention-v2.json",
      "56e4052b4cff23fe7d71266a482386870d1cf1fe5593016d808318c2dcb06e97",
    ],
    [
      "spec/conformance/2password-policy.json",
      "d417db1c621304546ac96ef68b4baa8ab63930374b25837ba0142e9c8b1514d2",
    ],
    [
      "spec/connectors/fnox-parity.json",
      "5c6fed69321f33b5d4d42ac48e27515252c1cdc3c5a86cc429ce47669c4dcad7",
    ],
  ].map(([file, hash]) => ({
    kind: "json-default",
    path: `${root}/${file}`,
    hash,
    exportName: "default",
    assetName: `generated-data/${file.replaceAll("/", "-")}`,
  })),
  {
    kind: "rows",
    path: `${root}/packages/app-core/src/lib/connect-presets.generated.ts`,
    hash: "54db1e86b11675f073ceccb99d0bc536d6d0f5259859601afe0a55929f4115ef",
    exportName: "CONNECT_PLAN_JSON",
    assetName: "generated-data/connect-presets.json",
  },
  {
    kind: "rows",
    path: `${root}/packages/app-core/src/lib/connector-catalog.generated.ts`,
    hash: "171d5f74c402a38c6ae95514b0242c717c82099e9bee4f1034813f984d55c9be",
    exportName: "CATALOG_ROW_JSON",
    assetName: "generated-data/connector-catalog.json",
  },
  {
    kind: "packed-string",
    path: `${root}/packages/app-core/src/lib/native-browser-policy.generated.ts`,
    hash: "91904d5e4f6a2dc9bd127a5f0ca59990d594c9d073a9933dec80c4e3e649f59a",
    exportName: "NATIVE_BROWSER_POLICY_JSON",
    assetName: "generated-data/native-browser-policy.json",
  },
  {
    kind: "packed-string",
    path: `${root}/packages/app-core/src/lib/native-browser-policy.runtime.generated.ts`,
    hash: "ca673d18b2d210d4021d97d9c484de13af1c8b83af1e56562d7bfdc662085c3a",
    exportName: "NATIVE_BROWSER_POLICY_RUNTIME_JSON",
    assetName: "generated-data/native-browser-policy-runtime.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/lib/identity-presets.generated.ts`,
    hash: "d2a08ad6acc1a7de898c338f5c4b5b764cd5a9fe49376028849468a1a2fb3ada",
    exportName: "IDENTITY_CONNECTION_PRESETS",
    assetName: "generated-data/identity-presets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/feature-catalog.ts`,
    hash: "938d09ad737d08b2a9386c7647814216dcce964f06b29c03622edd67f4f2b13a",
    exportName: "FEATURE_TARGETS",
    assetName: "generated-data/tutorial-feature-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/vault-catalog.ts`,
    hash: "0e66db520ac6292aed73da58129117fb8e15afa3d0d552b477446325258757fe",
    exportName: "VAULT_TARGETS",
    assetName: "generated-data/tutorial-vault-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/integration-catalog.ts`,
    hash: "fe202fc9e96c6da0f9fda214bdefb9f59161fec4258da94dc3555962684de067",
    exportName: "INTEGRATION_TARGETS",
    assetName: "generated-data/tutorial-integration-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/shell-catalog.ts`,
    hash: "007329104a7117c7c113ac92762352fa177f1d3f07c30e88c0a11ab40064ec67",
    exportName: "SHELL_TARGETS",
    assetName: "generated-data/tutorial-shell-targets.json",
  },
  tutorialDataModule(
    "identity-goals",
    "c9ad1c9b1160aec0babec4f12dd7d5779410e1ca69ca1f42c699bc326fc3ab5b",
    ["IDENTITY_GOALS", "IDENTITY_HELP"],
  ),
  tutorialDataModule(
    "feature-goals",
    "2a5eac42ea8d4b3129ab19544f16d97c02ac8895d4d6882e57531217c4555408",
    ["FEATURE_GOALS", "FEATURE_TUTORIALS"],
  ),
  tutorialDataModule(
    "connections-goals",
    "c334cf4879978e01d325da96948f8e18e842deff88d72eb450ca5f28b4a6631b",
    ["CONNECTIONS_GOALS", "CONNECTIONS_HELP"],
  ),
  tutorialDataModule(
    "gate-goals",
    "e0705e52924691255a929c74ab2e6d1ff3d260653a5444b08384608779a57672",
    ["GATE_GOALS"],
  ),
  tutorialDataModule(
    "integration-goals",
    "e6046a207b7149a72c6be4c817bb406df0d39c2b20192e505ed24554bdb3e4a9",
    ["INTEGRATION_GOALS", "INTEGRATION_TUTORIALS"],
  ),
  tutorialDataModule(
    "settings-goals",
    "733c8db1e5bf49910d6f010698a73ab414c971c83eb0305e9d0120205d59acac",
    ["SETTINGS_GOALS"],
  ),
  tutorialDataModule(
    "vault-item-goals",
    "5164998fe39079c0d3e0fcb7074dd51cb6a2220c05e0da04db3b516929ce2c2a",
    ["VAULT_ITEM_GOALS"],
  ),
  tutorialDataModule(
    "access-goals",
    "224eb42e7a941591f8d7f5e56273e2ed0efbdb71894a036efcc18ca065059d48",
    ["ACCESS_GOALS", "ACCESS_HELP"],
  ),
  tutorialDataModule(
    "shell-tour-goals",
    "54c6ec850f5c4796a2867193363827aaa57ebb782fdd516bb72eec940d880247",
    ["SHELL_TOUR_GOALS"],
  ),
  tutorialDataModule(
    "keyboard-goals",
    "e98bf533568889985bf8cdac18940318ed4cd912b3db29dc0a5355ef0dabbc1b",
    ["KEYBOARD_GOALS"],
  ),
  tutorialDataModule(
    "vault-create-goals",
    "085fcc50e721d8514136e4b8026eb3b88f568454c8b202ba7620ae3914aace27",
    ["FIRST_ITEM_GOAL", "CREATE_ITEM_GOAL"],
  ),
  tutorialDataModule(
    "duress-goals",
    "97f5aba0312013c90decff7950bd020656577abe4184f8e1b4eb955d6fc42a66",
    ["DURESS_GOALS", "DURESS_HELP"],
  ),
  tutorialDataModule(
    "section-nav-goals",
    "e63e1a8e856713d5a00461c3a03fd6f2e272e22d7c80cd8a8a2c0ac563230eef",
    [
      "NAV_ACCESS_GOALS",
      "NAV_ACTIVITY_GOALS",
      "NAV_CONNECTIONS_GOALS",
      "NAV_IDENTITY_GOALS",
      "NAV_WALLET_GOALS",
    ],
  ),
  tutorialDataModule(
    "authority-help",
    "1d71b7f71ea0eeee824646c8046970822ab959221948589403b393297d89de5a",
    ["AUTHORITY_HELP", "AUTHORITY_GOALS", "AUTHORITY_TUTORIALS"],
  ),
  tutorialDataModule(
    "item-reference-help",
    "a8c67f63f854506c4876efaf70a277296f076a2dd1045ea067a35cce0fa80038",
    ["ITEM_REFERENCE_HELP"],
  ),
  tutorialDataModule(
    "environments-goal",
    "e2de47281dddea82eee89001d4858b9e41c4318dda9568462bb0af79fa392ba1",
    ["ENVIRONMENTS_GOAL"],
  ),
  tutorialDataModule(
    "health-goal",
    "fafd35f6952435dabeb22ec16b10e6f283806d75847ff28892a721e2c287433a",
    ["HEALTH_REVIEW_GOAL"],
  ),
]);

function normalizedId(id) {
  return id.replaceAll("\\", "/");
}

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

function exportExpression(source, descriptor) {
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

/** Read reviewed literals from a source-hash-pinned generated/static module. */
export function readPackedGeneratedData(source, descriptor) {
  assertPinnedSource(source, descriptor);
  if (descriptor.kind === "capability-catalog") {
    return readCapabilityCatalogData(descriptor);
  }
  if (descriptor.kind === "bundled-export") {
    return readBundledExportData(descriptor);
  }
  if (descriptor.kind === "json-default") {
    return Object.freeze({ value: Object.freeze(JSON.parse(source)) });
  }
  if (descriptor.kind === "pack-index") {
    const tailStart = source.indexOf("/** One dynamic import per pack");
    if (tailStart < 0) throw new Error("PACK_INDEX generated boundary drifted");
    return readLiteralModuleData(source.slice(0, tailStart), {
      ...descriptor,
      exportNames: [descriptor.exportName],
    });
  }
  if (descriptor.kind === "literal-module") {
    return readLiteralModuleData(source, descriptor);
  }
  if (descriptor.kind === "literal-array") {
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
  if (descriptor.kind === "packed-string") {
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
    if (typeof value !== "string") {
      throw new Error(
        `${descriptor.exportName} generated data is not a string`,
      );
    }
    JSON.parse(value);
    return Object.freeze({ value });
  }
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
  // The pinned generator emits only string and array literals in this slice.
  // Evaluating that reviewed build input avoids parsing TypeScript by regex.
  const data = Function(
    `"use strict";${declaration};return { dictionary, rows };`,
  )();
  if (
    !Array.isArray(data.dictionary) ||
    !data.dictionary.every((value) => typeof value === "string") ||
    !Array.isArray(data.rows) ||
    !data.rows.every((value) => typeof value === "string")
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

export function renderGeneratedDataModule(source, descriptor, referenceId) {
  const data = readPackedGeneratedData(source, descriptor);
  const reference = `import.meta.ROLLUP_FILE_URL_${referenceId}`;
  if (descriptor.kind === "bundled-export") {
    return {
      code: `const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} static data (\${response.status})\`,
  );
}
const { value } = await response.json();
export const ${descriptor.exportName} = value;
`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "json-default") {
    return {
      code: `const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.assetName} (\${response.status})\`,
  );
}
const { value } = await response.json();
export default value;
`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "pack-index") {
    const exportStart = source.indexOf(`export const ${descriptor.exportName}`);
    const assignment = source.indexOf("=", exportStart);
    const tailStart = source.indexOf(
      "/** One dynamic import per pack",
      assignment,
    );
    if (exportStart < 0 || assignment < 0 || tailStart < 0) {
      throw new Error("PACK_INDEX generated boundary drifted");
    }
    const prefix = source.slice(0, exportStart).trimEnd();
    const declaration = source.slice(exportStart, assignment + 1).trimEnd();
    const tail = source.slice(tailStart);
    return {
      code: `${prefix}

const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} generated data (\${response.status})\`,
  );
}
const { values } = await response.json();
${declaration} values.${descriptor.exportName};

${tail}`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "capability-catalog") {
    const authoredImport = source.indexOf(
      'import { BROWSER_LOCAL_DESCRIPTORS } from "./catalog-always-on-local.js";',
    );
    const catalogStart = source.indexOf(
      "export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog(",
    );
    const catalogEnd = source.indexOf("\n);", catalogStart);
    if (authoredImport < 0 || catalogStart < 0 || catalogEnd < 0) {
      throw new Error("Capability catalog source boundary drifted");
    }
    const prefix = source.slice(0, authoredImport).trimEnd();
    const versionStart = source.indexOf(
      "export const CATALOG_VERSION",
      authoredImport,
    );
    const versionEnd = source.indexOf(";", versionStart) + 1;
    if (versionStart < 0 || versionEnd <= versionStart) {
      throw new Error("Capability catalog version boundary drifted");
    }
    const version = source.slice(versionStart, versionEnd);
    const tail = source.slice(catalogEnd + 3);
    return {
      code: `${prefix}

const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} static data (\${response.status})\`,
  );
}
const { descriptors } = await response.json();
${version}
export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog(
  descriptors,
  CATALOG_VERSION,
);${tail}`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "literal-module") {
    const exports = descriptor.exportNames
      .map((name) => `export const ${name} = values.${name};`)
      .join("\n");
    return {
      code: `const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} static data (\${response.status})\`,
  );
}
const { values } = await response.json();
${exports}
`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "literal-array") {
    const { exportStart, assignment } = exportExpression(source, descriptor);
    const prefix = source.slice(0, exportStart).trimEnd();
    const declaration = source.slice(exportStart, assignment + 1).trimEnd();
    return {
      code: `${prefix}

const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} static data (\${response.status})\`,
  );
}
const { value } = await response.json();
${declaration} value;
`,
      data,
      map: null,
    };
  }
  if (descriptor.kind === "packed-string") {
    const importStart = source.indexOf(
      'import { unpackGeneratedJson } from "./generated-json.js";',
    );
    if (importStart < 0) {
      throw new Error(`${descriptor.exportName} unpack import is missing`);
    }
    const prefix = source.slice(0, importStart).trimEnd();
    return {
      code: `${prefix}

const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} generated data (\${response.status})\`,
  );
}
const { value } = await response.json();
export const ${descriptor.exportName} = value;
`,
      data,
      map: null,
    };
  }
  const importStart = source.indexOf(
    'import { unpackGeneratedJson } from "./generated-json.js";',
  );
  if (importStart < 0) {
    throw new Error(`${descriptor.exportName} unpack import is missing`);
  }
  const prefix = source.slice(0, importStart).trimEnd();
  return {
    code: `${prefix}
import { unpackGeneratedJson } from "./generated-json.js";

const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${descriptor.exportName} generated data (\${response.status})\`,
  );
}
const { dictionary, rows } = await response.json();
export const ${descriptor.exportName}: readonly string[] = rows.map((row) =>
  unpackGeneratedJson(row, dictionary),
);
`,
    data,
    map: null,
  };
}

/**
 * Large public generated/static tables remain byte-for-byte owned by their
 * checked-in sources, but ship as precached JSON instead of JavaScript syntax.
 * Top-level await preserves the existing synchronous exports for every caller.
 */
export function generatedDataAssets() {
  let transformed = new Set();
  const jsonDescriptors = generatedModules.filter(
    (descriptor) => descriptor.kind === "json-default",
  );
  const jsonIds = new Map(
    jsonDescriptors.map((descriptor, index) => [
      `\0opensesame:generated-json:${index}`,
      descriptor,
    ]),
  );
  return {
    name: "opensesame-generated-data-assets",
    apply: "build",
    enforce: "pre",
    buildStart() {
      transformed = new Set();
    },
    resolveId(source, importer) {
      for (const [id, descriptor] of jsonIds) {
        if (
          source === descriptor.specifier ||
          normalizedId(source) === descriptor.path
        ) {
          return id;
        }
        if (
          importer &&
          source.startsWith(".") &&
          normalizedId(resolve(dirname(importer.split("?", 1)[0]), source)) ===
            descriptor.path
        ) {
          return id;
        }
      }
      return null;
    },
    load(id) {
      const descriptor = jsonIds.get(id);
      if (!descriptor) return null;
      const source = readFileSync(descriptor.path, "utf8");
      const data = readPackedGeneratedData(source, descriptor);
      const referenceId = this.emitFile({
        type: "asset",
        name: descriptor.assetName,
        source: JSON.stringify(data),
      });
      transformed.add(descriptor.path);
      return renderGeneratedDataModule(source, descriptor, referenceId);
    },
    transform(source, id) {
      const descriptor = generatedModules.find(
        (candidate) => normalizedId(id) === candidate.path,
      );
      if (!descriptor) return null;
      if (descriptor.kind === "json-default") return null;
      if (transformed.has(descriptor.path)) {
        throw new Error(`${descriptor.exportName} transformed more than once`);
      }
      const data = readPackedGeneratedData(source, descriptor);
      const referenceId = this.emitFile({
        type: "asset",
        name: descriptor.assetName,
        source: JSON.stringify(data),
      });
      transformed.add(descriptor.path);
      return renderGeneratedDataModule(source, descriptor, referenceId);
    },
  };
}

export function generatedDataInputs() {
  return generatedModules.map((descriptor) => ({
    ...descriptor,
    source: readFileSync(descriptor.path, "utf8"),
  }));
}
