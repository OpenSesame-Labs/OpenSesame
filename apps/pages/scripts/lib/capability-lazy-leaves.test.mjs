import assert from "node:assert/strict";
import { test } from "vitest";
import { LIB_RULES } from "../../src/lib/capabilities/classification-lib.js";
import { PACKAGE_RULES } from "../../src/lib/capabilities/classification-packages.js";
import { classifyModule } from "./capability-graph.mjs";
import {
  lazyLeafChunk,
  secretBackendSdkChunk,
} from "./capability-lazy-leaves.mjs";

function expectLeaf(file, entry, chunk) {
  assert.equal(lazyLeafChunk(file, entry), chunk);
  assert.equal(lazyLeafChunk(file.replaceAll("/", "\\"), entry), chunk);
}
test("keeps the NATS signer with its carrier instead of connector metadata", () => {
  const file = "/repo/node_modules/tweetnacl/nacl-fast.js";
  const owner = classifyModule(file, PACKAGE_RULES, { repoRoot: "/repo" });
  assert.equal(owner.classification, "optional");
  assert.equal(owner.capability, "sharing.live");
  expectLeaf(file, owner, "live-nats");
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "connectors.external",
    }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk("/repo/node_modules/tweetnacl-extra/index.js", owner),
    undefined,
  );
});
test("pins the optional Tailnet pairing leaf without changing ownership of other modules", () => {
  const file =
    "/workspace/packages/app-core/src/lib/tailnet-sync/plugin-pairing.ts";
  const entry = {
    classification: "optional",
    capability: "networking.tailnet",
  };
  expectLeaf(file, entry, "tailnet-plugin-pairing");
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "connectors.external",
    }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/tailnet-sync/plugin-daemon.ts",
      entry,
    ),
    undefined,
  );
});
test("pins the relay client to its capability's chunk and nothing else under vault-relay", () => {
  const entry = { classification: "optional", capability: "sharing.relay" };
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/client.ts",
      entry,
    ),
    "cap-sharing.relay",
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/client.ts",
      {
        classification: "shared",
        capability: null,
      },
    ),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/vault-relay/other.ts",
      entry,
    ),
    undefined,
  );
});
test("pins the claim different-link control on identity.ceremonies", () => {
  const file =
    "/workspace/apps/pages/src/modules/identity.ceremonies/ClaimDifferentLink.tsx";
  const entry = {
    classification: "optional",
    capability: "identity.ceremonies",
  };
  assert.equal(lazyLeafChunk(file, entry), "cap-identity.claim-different-link");
});
test("pins CLI app-integration crypto leaves on identity.local-iam", () => {
  const entry = {
    classification: "optional",
    capability: "identity.local-iam",
  };
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/cli-app-integration/device-crypto.ts",
      entry,
    ),
    "cli-app-integration-crypto",
  );
  assert.equal(
    lazyLeafChunk(
      "/workspace/packages/app-core/src/lib/cli-app-integration/device-crypto.ts",
      { classification: "core", capability: "shell.navigation" },
    ),
    "cli-app-integration-crypto",
  );
});
test("keeps local IAM rail and authorize screens outside the runtime initializer", () => {
  const entry = {
    classification: "optional",
    capability: "identity.local-iam",
  };
  for (const [file, chunk] of [
    [
      "/workspace/apps/pages/src/modules/identity.local-iam/IdentityRailTree.tsx",
      "identity-local-iam-rail",
    ],
    [
      "/workspace/apps/pages/src/modules/identity.local-iam/lazy-routes.tsx",
      "identity-local-iam-authorize-route",
    ],
    [
      "/workspace/apps/pages/src/modules/identity.local-iam/AuthorizeConsentScreen.tsx",
      "identity-local-iam-authorize-consent",
    ],
  ]) {
    assert.equal(lazyLeafChunk(file, entry), chunk);
  }
});
test("keeps the activation-awaited security checks panel outside its runtime chunk", () => {
  const cases = [
    [
      "/workspace/packages/app-core/src/lib/vault/security-checks.ts",
      { classification: "shared", capability: null },
    ],
    [
      "/workspace/apps/pages/src/modules/vault.security-checks/SecurityChecksPanel.tsx",
      {
        classification: "optional",
        capability: "vault.security-checks",
      },
    ],
    [
      "/workspace/apps/pages/src/modules/vault.security-checks/SecurityChecksPanelBody.tsx",
      {
        classification: "optional",
        capability: "vault.security-checks",
      },
    ],
  ];
  for (const [file, entry] of cases) {
    expectLeaf(file, entry, "vault-security-checks-panel");
  }
});
test("keeps password-reset mailbox leaves within their matching optional capability", () => {
  const entry = { classification: "optional", capability: "ai.password-reset" };
  for (const name of [
    "handled",
    "jmap",
    "legacy-emails",
    "mail-type.generated",
    "mail-type",
    "mailbox-connection",
    "mailbox-store",
  ]) {
    const path = `/workspace/packages/app-core/src/lib/password-reset/${name}.ts`;
    expectLeaf(path, entry, "cap-ai.password-reset");
    assert.equal(
      lazyLeafChunk(path, { classification: "shared", capability: null }),
      undefined,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "optional",
        capability: "connectors.external",
      }),
      undefined,
    );
  }
});
test("keeps backup SDKs and authority UI in separate lazy capability chunks", () => {
  const paths = [
    [
      "/packages/app-core/src/lib/secret-backends/bitwarden.worker.ts",
      "connectors.external",
      "secret-backends",
    ],
    [
      "/node_modules/@1password/save-button/dist/index.js",
      "connectors.external",
      "vendor-1password-save",
    ],
    [
      "/src/sections/access/HostedRequestsPanel.tsx",
      "access.authority",
      "access-hosted-requests",
    ],
    [
      "/src/modules/access.authority/AccessRailTree.tsx",
      "access.authority",
      "access-authority-rail",
    ],
  ];
  for (const [path, capability, chunk] of paths) {
    assert.equal(
      lazyLeafChunk(path, { classification: "optional", capability }),
      chunk,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "core",
        capability: "shell.navigation",
      }),
      undefined,
    );
    assert.equal(
      lazyLeafChunk(path, {
        classification: "optional",
        capability: "sharing.live",
      }),
      undefined,
    );
  }
});
const nativeOwner = {
  classification: "optional",
  capability: "connectors.external",
};
const backendPath = "/workspace/packages/app-core/src/lib/secret-backends/";
const nativeSdkChunk = "secret-backend-onepassword-sdk";
test.each([
  "onepassword-sdk.ts",
  "onepassword-sdk-loader.ts",
  "onepassword-sdk-codec.ts",
  "onepassword-sdk-write.ts",
  "onepassword-sdk.worker.ts",
  "onepassword-worker-http.ts",
  "onepassword-worker-protocol.js",
])("isolates native SDK source %s before the common backend leaf", (name) => {
  const file = `${backendPath}${name}`;
  for (const id of [
    file,
    file.replaceAll("/", "\\"),
    `${file}?worker_file&type=module`,
    `${file}#source`,
  ]) {
    assert.equal(secretBackendSdkChunk(id, nativeOwner), nativeSdkChunk);
    assert.equal(lazyLeafChunk(id, nativeOwner), nativeSdkChunk);
  }
});
test("native SDK isolation requires its optional connector owner", () => {
  const file = `${backendPath}onepassword-sdk.ts`;
  for (const entry of [
    { classification: "core", capability: "connectors.external" },
    { classification: "shared", capability: "connectors.external" },
    { classification: "optional", capability: "sharing.live" },
    { classification: "shared", capability: null },
  ]) {
    assert.equal(secretBackendSdkChunk(file, entry), undefined);
    assert.notEqual(
      lazyLeafChunk(file, entry),
      "secret-backend-onepassword-sdk",
    );
  }
});
test("Connect, common configuration and other SDKs keep the ordinary backend leaf", () => {
  for (const name of [
    "onepassword.ts",
    "factory.ts",
    "schema.ts",
    "types.ts",
    "presets.ts",
    "http.ts",
    "onepassword-artifacts.json",
    "bitwarden-sdk.ts",
    "bitwarden.worker.ts",
    "onepassword-sdking.ts",
  ]) {
    const file = `${backendPath}${name}`;
    assert.equal(secretBackendSdkChunk(file, nativeOwner), undefined);
    assert.equal(lazyLeafChunk(file, nativeOwner), "secret-backends");
  }
  const save = "/workspace/node_modules/@1password/save-button/dist/index.js";
  assert.equal(secretBackendSdkChunk(save, nativeOwner), undefined);
  assert.equal(lazyLeafChunk(save, nativeOwner), "vendor-1password-save");
});
test("the browser credential adapter stays with its actual backend owner", () => {
  const file =
    "/workspace/packages/app-core/src/browser/secret-backend-credentials.ts";
  const entry = classifyModule(file, LIB_RULES, { repoRoot: "/workspace" });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "connectors.external");
  expectLeaf(file, entry, "secret-backends");
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "sharing.live",
    }),
    undefined,
  );
  const neighbor =
    "/workspace/packages/app-core/src/browser/kdbx-native-dom.ts";
  assert.equal(
    lazyLeafChunk(
      neighbor,
      classifyModule(neighbor, LIB_RULES, { repoRoot: "/workspace" }),
    ),
    undefined,
  );
});
test("virtual IDs, unrelated packages and query lookalikes cannot claim the native leaf", () => {
  for (const id of [
    `\0${backendPath}onepassword-sdk.ts`,
    `virtual:${backendPath}onepassword-sdk.ts`,
    "/workspace/packages/other/src/lib/secret-backends/onepassword-sdk.ts",
    `${backendPath}onepassword-sdk.test.ts`,
    `${backendPath}onepassword-sdk-loader.tsx`,
    `${backendPath}onepassword-sdk.ts/nested.js`,
    `${backendPath}onepassword.ts?${backendPath}onepassword-sdk.ts`,
  ]) {
    assert.equal(secretBackendSdkChunk(id, nativeOwner), undefined);
    assert.notEqual(
      lazyLeafChunk(id, nativeOwner),
      "secret-backend-onepassword-sdk",
    );
  }
});
// Actual owner, not a test-only reclassification of the pure organization model.
test("keeps the directory sign-in model off the bootstrap without promoting its owner", () => {
  const file = "/workspace/packages/app-core/src/lib/org-signin.ts";
  const entry = classifyModule(file, LIB_RULES, { repoRoot: "/workspace" });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "enterprise.directory-provisioning");
  expectLeaf(file, entry, "directory-signin-model");
  for (const owner of [
    { classification: "shared", capability: null },
    { classification: "core", capability: null },
    { classification: "optional", capability: "connectors.external" },
  ])
    assert.equal(lazyLeafChunk(file, owner), undefined);
  for (const name of [
    "org-signin.test.ts",
    "org-signin-other.ts",
    "identity-enterprise.ts",
  ])
    assert.equal(
      lazyLeafChunk(file.replace("org-signin.ts", name), entry),
      undefined,
    );
});
test("keeps the real NKeys signer with NATS without claiming virtual wrappers or connector credentials", () => {
  const root = "/workspace";
  const source = `${root}/node_modules/tweetnacl/nacl-fast.js`;
  const entry = classifyModule(source, PACKAGE_RULES, { repoRoot: root });
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "sharing.live");
  expectLeaf(source, entry, "live-nats");
  const wrapper = `\0${source}?commonjs-module`;
  const wrapperEntry = classifyModule(wrapper, PACKAGE_RULES, {
    repoRoot: root,
  });
  assert.equal(wrapperEntry.rationale, "virtual");
  assert.equal(lazyLeafChunk(wrapper, wrapperEntry), undefined);
  for (const owner of [
    { classification: "shared", capability: null },
    { classification: "core", capability: null },
    { classification: "optional", capability: "connectors.external" },
  ])
    assert.equal(lazyLeafChunk(source, owner), undefined);
  const credentials = `${root}/packages/app-core/src/browser/secret-backend-credentials.ts`;
  const credentialOwner = classifyModule(credentials, LIB_RULES, {
    repoRoot: root,
  });
  assert.equal(credentialOwner.classification, "optional");
  assert.equal(credentialOwner.capability, "connectors.external");
  // The credential adapter keeps its own backend leaf; the NKeys mapping
  // above must not absorb it.
  assert.equal(lazyLeafChunk(credentials, credentialOwner), "secret-backends");
  assert.equal(
    lazyLeafChunk(source.replace("/tweetnacl/", "/tweetnacl-extra/"), entry),
    undefined,
  );
});
