import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGeneratedDataAssets } from "./lib/generated-data-plugin.mjs";
import { readPackedGeneratedData } from "./lib/generated-data-read.mjs";
import { renderGeneratedDataModule } from "./lib/generated-data-render.mjs";

export { readPackedGeneratedData, renderGeneratedDataModule };

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
      hash: "4f167e9ac40a96addd300ddc723117777e40d05d64d1a9f24d5d683ddcbd072c",
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
    path: `${root}/apps/pages/src/sections/connections/connector-marks.generated.json`,
    hash: "f295248680222c831fb2a095874a991f7a1d8a2d86704074a8424fce872d6282",
    exportName: "default",
    assetName: "generated-data/connector-marks.json",
  },
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
    kind: "literal-module",
    path: `${root}/packages/app-core/src/lib/secret-backends/presets.generated.ts`,
    hash: "3d7c42ac82c818f42a3cea8b0f0e913f98268041fe92190b081c27799791d447",
    exportName: "SECRET_BACKEND_PRESETS",
    exportNames: ["SECRET_BACKEND_PRESETS"],
    assetName: "generated-data/secret-backend-presets.json",
  },
  {
    kind: "literal-module",
    path: `${root}/packages/app-core/src/lib/ai-model-provider-ids.generated.ts`,
    hash: "cd6cd1bb05b1746300807dacdc0da00f97ff3f2bd32679592c72dbe99dacaa5d",
    exportName: "AI_MODEL_PROVIDER_IDS",
    exportNames: ["AI_MODEL_PROVIDER_IDS"],
    assetName: "generated-data/ai-model-provider-ids.json",
  },
  {
    kind: "packed-string",
    path: `${root}/packages/app-core/src/lib/browser-dispositions.generated.ts`,
    hash: "563ff8bc1dbad880c73a1459a7fa6392a38b3ee1f1a39839a7c6ba786392b8a5",
    exportName: "BROWSER_DISPOSITIONS_JSON",
    assetName: "generated-data/browser-dispositions.json",
  },
  {
    kind: "literal-module",
    path: `${root}/packages/app-core/src/lib/quorum/item-types.generated.ts`,
    hash: "2267ea8c955e188464a09e91aee35522d00b2083fc6df8e238b9e75c95dac3ad",
    exportName: "QUORUM_TYPES",
    exportNames: ["QUORUM_TYPES"],
    assetName: "generated-data/quorum-item-types.json",
  },
  {
    kind: "literal-module",
    path: `${root}/packages/app-core/src/lib/password-reset/mail-type.generated.ts`,
    hash: "942059db34a2e17f36250dad8304c5e79dee820ba52f39243a39d7105ec92436",
    exportName: "RESET_MAIL_TYPES",
    exportNames: ["RESET_MAIL_TYPES"],
    assetName: "generated-data/password-reset-mail-types.json",
  },
  {
    kind: "literal-module",
    path: `${root}/packages/app-core/src/lib/native-google-account-policy.generated.ts`,
    hash: "d05244174888357bf4e93b02271bcb595e3040d674b32fb0e19e03109fd03b7d",
    exportName: "GOOGLE_ACCOUNT_POLICY",
    exportNames: ["GOOGLE_ACCOUNT_POLICY"],
    assetName: "generated-data/native-google-account-policy.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/feature-catalog.ts`,
    hash: "aad6136f2a8ddfbcdabb14bfdc9b03d1a22e49d38a41f39df9fffcf250eba0e9",
    exportName: "FEATURE_TARGETS",
    assetName: "generated-data/tutorial-feature-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/vault-catalog.ts`,
    hash: "ed2669bcfcbfd2a9d08a591b9be6d6d37edea7963d0d1048150922442e6c8de8",
    exportName: "VAULT_TARGETS",
    assetName: "generated-data/tutorial-vault-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/integration-catalog.ts`,
    hash: "5fcf73f4a41454724d933db1ef0a0add81c6c47718d9e9bcdd63554ecc743b37",
    exportName: "INTEGRATION_TARGETS",
    assetName: "generated-data/tutorial-integration-targets.json",
  },
  {
    kind: "literal-array",
    path: `${root}/packages/app-core/src/tutorial/registry/shell-catalog.ts`,
    hash: "5cd00570720724e4150977a2ae437fe1da40bf665d68c8df52276b42bdb543b7",
    exportName: "SHELL_TARGETS",
    assetName: "generated-data/tutorial-shell-targets.json",
  },
  {
    kind: "embedded-array",
    path: `${root}/packages/app-core/src/lib/keymap/commands.ts`,
    hash: "14dd939d6d698e216936c46347d4c4e0453c7985b4a67d969a99add80bd77fd3",
    exportName: "COMMANDS",
    assetName: "generated-data/keymap-commands.json",
    declaration: "const COMMANDS: readonly KeymapCommand[] =",
    expressionEnd: ";\n\n/** The two jumps",
    bindingNames: ["REGISTER_PREFIX", "REGISTER_RECORD", "REGISTER_REPLAY"],
  },
  {
    kind: "embedded-array",
    path: `${root}/packages/app-core/src/tutorial/registry/areas.ts`,
    hash: "ad75f1195094955937317637b7059e36f1dca6445570a8de5efbd1992a72a63b",
    exportName: "TUTORIAL_AREAS",
    assetName: "generated-data/tutorial-areas.json",
    declaration: "export const TUTORIAL_AREAS: readonly TutorialArea[] =",
    expressionEnd: ";\n\n/** The directives",
  },
  {
    kind: "embedded-array",
    path: `${root}/packages/app-core/src/lib/field-guidance.ts`,
    hash: "bf70dc3b5cd2b80e650d8ee48f368758dbd0d3caef9e1e2b6a50959fb41bc482",
    exportName: "FIELD_GUIDANCE",
    assetName: "generated-data/field-guidance.json",
    declaration: "const FIELD_GUIDANCE = new Map<string, FieldGuidance>(",
    expressionEnd: ");\n\nexport function fieldGuidance",
  },
  // These modules retain runtime state, touch detection, or live imports:
  // gate-goals, vault-item-goals, shell-tour-goals, and vault-create-goals.
  // Keep them as JavaScript so JSON extraction cannot freeze their behavior.
  tutorialDataModule(
    "identity-goals",
    "c480f855b17dbdf88a924433c6441a2425816ba09905e9aae29a29e3f3198e8e",
    ["IDENTITY_GOALS", "IDENTITY_HELP"],
  ),
  tutorialDataModule(
    "feature-goals",
    "488d62db43b0326ef22777554e7a681623f2e4ebfcb39379e2613945a0c64bfd",
    ["FEATURE_GOALS", "FEATURE_TUTORIALS"],
  ),
  tutorialDataModule(
    "connections-goals",
    "79a0863afa96562e7b33bef7242f0e0cc92f8e5becf4092b5dce3a20d4a16727",
    ["CONNECTIONS_GOALS", "CONNECTIONS_HELP"],
  ),
  tutorialDataModule(
    "integration-goals",
    "3afecff986280b4316c932e4ff6be929e15a70c2541e98733e220890fc488191",
    ["INTEGRATION_GOALS", "INTEGRATION_TUTORIALS"],
  ),
  tutorialDataModule(
    "settings-goals",
    "b436b2467b5f8b889011c6722ec0c3a73439c132c5a909893676539b37a0d1c4",
    ["SETTINGS_GOALS"],
  ),
  tutorialDataModule(
    "access-goals",
    "af05e684a9bdaa9208884b94c3e074e45bf9890c785d95cb9b765e5df2127d12",
    ["ACCESS_GOALS", "ACCESS_HELP"],
  ),
  tutorialDataModule(
    "keyboard-goals",
    "f2713f15765192eff63b93dbbbf8de15f58eb0407b893e462efb9f53f927a8ee",
    ["KEYBOARD_GOALS"],
  ),
  tutorialDataModule(
    "duress-goals",
    "18a04785c8dde1c3cfac5f8f668f669a45b7ae91cbdcec7f8147994d0ad33ab9",
    ["DURESS_GOALS", "DURESS_HELP"],
  ),
  tutorialDataModule(
    "section-nav-goals",
    "73e84986d1f05a616c29f979ea741d2876b73caf39abaa64f847faccd6414b9b",
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
    "4f167e9ac40a96addd300ddc723117777e40d05d64d1a9f24d5d683ddcbd072c",
    ["AUTHORITY_HELP", "AUTHORITY_GOALS", "AUTHORITY_TUTORIALS"],
  ),
  tutorialDataModule(
    "item-reference-help",
    "8160b85723a61aa53135a5ef1e6b73529f64c45e60ac72018100549864980652",
    ["ITEM_REFERENCE_HELP"],
  ),
  tutorialDataModule(
    "environments-goal",
    "851a6a9f6a39c6065af69759a245f5dd49e5de59bc1708124ed470d7a07cd115",
    ["ENVIRONMENTS_GOAL"],
  ),
  tutorialDataModule(
    "health-goal",
    "8e04f737787fc2d09df151d2e28d8200b4893be57652f93e02cb4c0286b02a28",
    ["HEALTH_REVIEW_GOAL"],
  ),
]);

export function generatedDataAssets() {
  return createGeneratedDataAssets(
    generatedModules,
    readPackedGeneratedData,
    renderGeneratedDataModule,
  );
}

export function generatedDataInputs() {
  return generatedModules.map((descriptor) => ({
    ...descriptor,
    source: readFileSync(descriptor.path, "utf8"),
  }));
}
