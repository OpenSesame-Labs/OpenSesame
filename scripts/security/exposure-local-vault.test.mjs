import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  coverageViolations,
  sha256,
  sourceArea,
} from "../lib/exposure-coverage.mjs";
import {
  LOCAL_VAULT_CONTRACT,
  LOCAL_VAULT_CONTROLS,
} from "../lib/exposure-local-vault.mjs";
import {
  encodeSourceDigest,
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";
import {
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";
import { CHECKER_SOURCES } from "./exposure-matrix-gate.mjs";

const ID = "local-vault-activation";
const lib = "packages/app-core/src/lib/";
const vault = `${lib}vault/`;
const baseline = parsePolicy(
  readFileSync(new URL(`../../${POLICY}`, import.meta.url)),
);
const matrix = () => structuredClone(baseline);
const row = (value) => value.surfaces.find((surface) => surface.id === ID);
const rules = (value) =>
  exposureViolations(validatePolicy(value)).map((issue) => issue.rule);

test("local activation is reviewed device-owner process custody with no global claims", () => {
  const value = matrix();
  const local = row(value);
  for (const field of [
    "kind",
    "area",
    "flow",
    "observer",
    "verification",
    "enforcement",
  ])
    assert.equal(local[field], LOCAL_VAULT_CONTRACT[field], field);
  assert.deepEqual(local.guarantees, []);
  assert.deepEqual(local.controls, [...LOCAL_VAULT_CONTROLS]);
  assert.deepEqual(rules(value), []);
});

for (const control of LOCAL_VAULT_CONTROLS) {
  test(`local activation cannot omit ${control}`, () => {
    const value = matrix();
    row(value).controls = row(value).controls.filter(
      (item) => item !== control,
    );
    assert.ok(rules(value).includes("EM-LOCAL-VAULT-CUSTODY"));
    assert.ok(!rules(value).includes("EM-IMPORT-CUSTODY"));
  });
}

for (const [field, values] of [
  ["kind", ["policy", "artifact", "online"]],
  [
    "observer",
    ["public", "authenticated", "authorized-recipient", "link-holder"],
  ],
  ["area", ["bitwarden", "portable-drop"]],
  ["flow", ["bitwarden-import", "portable-secret-drop"]],
  ["verification", ["none", "server", "signature", "code-aead"]],
  ["enforcement", ["none", "authoritative"]],
]) {
  for (const next of values) {
    test(`local activation cannot relabel ${field} as ${next}`, () => {
      const value = matrix();
      row(value)[field] = next;
      assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
    });
  }
}

for (const guarantee of ["single-use", "expiry", "revocation"]) {
  test(`local activation cannot claim global ${guarantee}`, () => {
    const value = matrix();
    row(value).guarantees = [guarantee];
    assert.throws(() => validatePolicy(value), /guarantee limits/u);
    row(value).enforcement = "authoritative";
    assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
  });
}

for (const artifact of LOCAL_VAULT_CONTRACT.artifacts) {
  test(`local custody cannot hide its ${artifact}`, () => {
    const value = matrix();
    row(value).artifacts = row(value).artifacts.filter(
      (item) => item !== artifact,
    );
    assert.throws(() => validatePolicy(value), /required artifact/u);
  });
}

test("local activation cannot be removed or renamed", () => {
  for (const rename of [false, true]) {
    const value = matrix();
    if (rename) row(value).id = "renamed-local-unlock";
    else value.surfaces = value.surfaces.filter((surface) => surface.id !== ID);
    assert.throws(
      () => validatePolicy(value),
      /required boundary local-vault-activation/u,
    );
  }
});

for (const template of ["local-vault-activation", "bitwarden-import"]) {
  test(`a new custody boundary cannot borrow ${template}'s classification`, () => {
    const value = matrix();
    value.surfaces.push({
      ...structuredClone(
        value.surfaces.find((surface) => surface.id === template),
      ),
      id: "unreviewed-custody",
      flow: "unreviewed-custody",
    });
    assert.ok(rules(value).includes("EM-CUSTODY-CONTRACT"));
  });
}

test("local controls cannot substitute for the existing import controls", () => {
  const value = matrix();
  value.surfaces.find((surface) => surface.id === "bitwarden-import").controls =
    [...LOCAL_VAULT_CONTROLS];
  assert.ok(rules(value).includes("EM-IMPORT-CUSTODY"));
});

test("every named local source and behavior regression is mandatory on its own surface", () => {
  for (const role of ["implementation", "regressions"]) {
    for (const path of LOCAL_VAULT_CONTRACT[role]) {
      const value = matrix();
      row(value)[role] = row(value)[role].filter((item) => item !== path);
      value.surfaces
        .find((surface) => surface.id === "bitwarden-import")
        [role].push(path);
      const snapshot = {
        paths: () => [],
        mode: () => "100644",
        read: () => Buffer.alloc(0),
      };
      assert.ok(
        coverageViolations(value, snapshot).some(
          (issue) =>
            issue ===
            `EM-BINDING: ${ID} is missing its ${role} binding ${path}`,
        ),
        `${role}: ${path}`,
      );
    }
  }
});

const futureSources = [
  `${vault}store-unlock-contact.ts`,
  `${vault}store-primary/new-entry.ts`,
  `${vault}store-header-publication/write.ts`,
  `${vault}vault-shared-locks/admit.ts`,
  `${vault}unlock-factor-crypto/pin.ts`,
  `${vault}protection/session-guard/check.ts`,
  `${vault}authentication-storage/refresh.ts`,
  `${lib}local-iam-access/read.ts`,
  `${lib}local-passkey-authentication/verify.ts`,
  `${lib}trusted-unlock-policy.ts`,
  `${lib}vfs-operation-check/owner.ts`,
  `${lib}kv-entry-lifecycle/publish.ts`,
  `${lib}projects-session/cache.ts`,
  `${lib}secret-fs/install/guarded-write.ts`,
  `${lib}secret-fs/files-owner/commit.ts`,
  `${lib}secret-fs/memory-owned.ts`,
  `${lib}secret-fs/filesystem/rename.ts`,
  `${lib}secret-fs/s3-write/dispatch.ts`,
  `${lib}secret-fs/resilient/retry.ts`,
  `${lib}secret-fs/vfs-files/publish.ts`,
  `${lib}secret-fs/vfs-files-settle/error.ts`,
  `${lib}secret-fs/vfs-file-keys/lookup.ts`,
  `${lib}secret-fs/vfs-body-delete/remove.ts`,
  `${lib}secret-fs/vfs-body-crypto/probe.ts`,
  `${lib}secret-fs/owned-body-files/commit.ts`,
  `${lib}secret-fs/projection-staging/remove.ts`,
  `${lib}secret-fs/secret-docs/verify.ts`,
  `${lib}secret-fs/config-docs/decode.ts`,
  `${lib}secret-fs/layout/path.ts`,
  `${lib}secret-fs/transient-guest-seams/publish.ts`,
  `${lib}guest-vault-id/validate.ts`,
  `${lib}guest-return-record/consume.ts`,
  `${lib}guest-return-epoch/check.ts`,
  `${lib}guest-session-context/retire.ts`,
  `${lib}guest-auth-entry/admit.ts`,
  `${lib}guest-auth-dependencies/session.ts`,
  `${lib}guest-provider-return/check.ts`,
  `${vault}guest-vault-promotion/recover.ts`,
  `${vault}guest-person-metadata/read.ts`,
  `${vault}store-guest-material/prepare.ts`,
  `${vault}store-open-lease/acquire.ts`,
  `${vault}ordinary-peer-body-refresh/read.ts`,
  `${vault}original-store-memory-body-proof-data/check.ts`,
  `${vault}original-unlock-policy-proof/verify.ts`,
  "packages/app-core/src/node/secret-files-owner.ts",
  `${lib}deadman/authentication/heartbeat.ts`,
  `${lib}deadman/state-publish.ts`,
  `${lib}deadman/fence/queue.ts`,
  `${lib}deadman/arm/commit.ts`,
  `${lib}vfs-sealed-index/revise.ts`,
  "packages/auth-upstream/src/passkey-verification/assertion.ts",
  "packages/sdk-browser/src/webauthn/assertion.ts",
];

test("bounded discovery follows named local entry, verification and persistence lanes", () => {
  for (const path of futureSources) assert.equal(sourceArea(path), ID, path);
  for (const path of [
    `${vault}store-unlock-future.test.ts`,
    `${lib}local-passkey-authentication/verify.spec.ts`,
    `${lib}unrelated-panel.ts`,
    "packages/auth-upstream/src/unrelated-verifier.ts",
    `${lib}deadman/package-format.ts`,
    `${lib}deadman/relay.ts`,
    `${lib}secret-fs/unrelated-storage-ui.ts`,
    `${lib}secret-fs/files-owner.test.ts`,
  ])
    assert.equal(sourceArea(path), undefined, path);
});

test("local activation helpers cannot borrow a new artifact row in the same area", () => {
  for (const path of [
    futureSources[0],
    `${lib}secret-fs/projection-staging/remove.ts`,
    `${lib}secret-fs/owned-body-files/commit.ts`,
    `${lib}secret-fs/vfs-file-keys/lookup.ts`,
    `${lib}guest-return-record/consume.ts`,
    `${vault}guest-vault-promotion/recover.ts`,
  ]) {
    const value = matrix();
    value.sources[path] = encodeSourceDigest(sha256(Buffer.alloc(0)));
    value.surfaces.push({
      ...structuredClone(row(value)),
      id: "local-helper-bookkeeping",
      flow: "local-helper-bookkeeping",
      kind: "artifact",
      artifacts: [],
      verification: "none",
      controls: [],
      implementation: [path],
    });
    assert.deepEqual(rules(value), []);
    const snapshot = {
      paths: () => [path],
      mode: () => "100644",
      read: () => Buffer.alloc(0),
    };
    assert.ok(
      coverageViolations(value, snapshot).some((issue) =>
        issue.startsWith(`EM-COVERAGE: unclassified protected source ${path};`),
      ),
      path,
    );
  }
});

test("real local sources and regressions fail on source drift", (t) => {
  const f = gateFixture(t);
  assertClean(f.run());
  for (const path of [
    `${vault}store.ts`,
    `${vault}store-unlock-session.ts`,
    `${vault}store-operation-check.ts`,
    `${vault}vault-shared-locks.ts`,
    `${lib}local-iam-access.ts`,
    `${lib}local-passkey-authentication.ts`,
    `${lib}local-credentials.ts`,
    `${lib}trusted-unlock.ts`,
    `${lib}vfs.ts`,
    `${lib}kv.ts`,
    `${lib}projects-session.ts`,
    `${lib}vfs-sealed-index.ts`,
    `${lib}deadman/authentication.ts`,
    `${lib}deadman/fence.ts`,
    `${lib}deadman/state.ts`,
    `${lib}deadman/arm.ts`,
    "packages/auth-upstream/src/passkey-verification.ts",
    `${vault}store-unlock-races.fixture.ts`,
    `${lib}local-authenticator.fixture.ts`,
    `${lib}secret-fs/install.ts`,
    `${lib}secret-fs/files-owner.ts`,
    `${lib}secret-fs/filesystem.ts`,
    `${lib}secret-fs/s3-write.ts`,
    `${lib}secret-fs/resilient.ts`,
    `${lib}secret-fs/device-identity-carry.test.ts`,
    `${lib}secret-fs/guarded-backends.test.ts`,
    `${lib}secret-fs/guarded-removal.test.ts`,
    `${lib}secret-fs/owned-metadata.test.ts`,
    `${lib}secret-fs/owned-body-files.ts`,
    `${lib}secret-fs/vfs-file-keys.ts`,
    `${lib}secret-fs/vfs-body-delete.ts`,
    `${lib}secret-fs/vfs-body-crypto.ts`,
    `${lib}secret-fs/vfs-files-settle.ts`,
    `${lib}secret-fs/projection-plan.ts`,
    `${lib}secret-fs/projection-staging.ts`,
    `${lib}secret-fs/projection-long-path.test.ts`,
    `${lib}secret-fs/vfs-body-ownership.test.ts`,
    `${lib}secret-fs/vfs-body-read-ownership.test.ts`,
    `${lib}secret-fs/vfs-delete-ownership.test.ts`,
    `${lib}vfs-tomb-keys.ts`,
    `${lib}vfs-plaintext.ts`,
    `${lib}vfs-registry-protected.test.ts`,
    `${lib}vfs-key-retirement.test.ts`,
    `${lib}guest-local-only.test.ts`,
    `${lib}github-app-manifest.test.ts`,
    `${lib}local-authorization.test.ts`,
    `${vault}store.guest-gates.test.ts`,
    `${vault}device-key-restore.test.ts`,
    `${lib}guest-return-record.ts`,
    `${lib}guest-auth-entry.ts`,
    `${vault}guest-vault-promotion.ts`,
    `${vault}store-preferences-lifetime.test.ts`,
    `${lib}vfs-guest-guard.test.ts`,
    `${lib}trusted-unlock-access-commit.test.ts`,
    `${lib}trusted-unlock-access-legacy.test.ts`,
    `${lib}vfs-guarded-commit.test.ts`,
    `${vault}store-unlock-deadman-lifetime.test.ts`,
    `${vault}store-unlock-registration-lifetime.test.ts`,
    `${lib}tailnet-sync/devices.fixture.ts`,
    `${lib}tailnet-sync/devices-lifecycle.test.ts`,
    "packages/app-core/src/browser/oidc/oidc.test-support.ts",
    "packages/app-core/src/browser/oidc/admission.test.ts",
    `${vault}store-unlock-trusted-custody.test.ts`,
    `${lib}trusted-unlock-access.test.ts`,
  ]) {
    f.write(path, `${f.read(path)}\n// deliberate unreviewed drift\n`);
    assertBlocked(f.run(), /EM-DRIFT/u);
    f.restore(path);
  }
});

test("new named helpers need classification even if somebody saves their hash", (t) => {
  const f = gateFixture(t);
  const path = futureSources[0];
  const bytes = "export const futureUnlock = () => {};\n";
  f.write(path, bytes);
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
  f.git(["add", path]);
  assertBlocked(
    f.run(["--staged"]),
    /EM-COVERAGE: unclassified protected source/u,
  );
  const value = matrix();
  value.sources[path] = encodeSourceDigest(sha256(Buffer.from(bytes)));
  assert.throws(() => validatePolicy(value), /unbound or invalid source/u);
  f.write(POLICY, `${JSON.stringify(value, null, 2)}\n`);
  assertBlocked(f.run(), /EM-SCHEMA/u);
});

test("the new contract helper participates in checker snapshot equality", (t) => {
  const f = gateFixture(t);
  const path = "scripts/lib/exposure-local-vault.mjs";
  assert.ok(CHECKER_SOURCES.includes(path));
  f.write(path, `${f.read(path)}\n// unstaged checker drift\n`);
  assertBlocked(f.run(["--staged"]), /EM-CHECKER-SNAPSHOT/u);
});
