import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GitHub, policyEntriesForTree } from "./lib/candidate-api.mjs";
import { CI_RECIPE, POLICY } from "./lib/candidate-policy.mjs";

const policies = [
  ".github/codeql/codeql-config.yml",
  ".github/codeql/custom/queries.qls",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".osv-scanner.toml",
  ".cargo/audit.toml",
  ".cargo/config.toml",
  "deny.toml",
  "osv-scanner.toml",
  ".semgrepignore",
  ".semgrep/rules.yml",
  "apps/.semgrepignore",
  ".gitignore",
  "apps/.gitignore",
  ".ignore",
  "apps/.rgignore",
  "sgconfig.yml",
  "apps/sgconfig.yaml",
  "scripts/lib/audit-directory.sh",
  "scripts/lib/dependency-compatibility.test.mjs",
  "scripts/fuzz/jazzer-gate.sh",
  "scripts/lib/fuzz-directory.sh",
  "scripts/mtls/mtls-fixtures.sh",
  "spec/formal/proof-registry.json",
  "spec/formal/proof-requirements.json",
  "spec/formal/check-axioms.sh",
  "spec/formal/check-axioms.test.mjs",
  "spec/formal/required-theorem-command.lean",
  "spec/formal/auth/AuthPolicy.lean",
  "spec/formal/auth/required-theorems.lean",
  "spec/formal/future/proof.lean",
  "scripts/test/auth-formal.sh",
  "scripts/test/auth-formal-drift.mjs",
  "scripts/security/formal-proof-release-gate.mjs",
  "scripts/security/formal-proof-required-suites.mjs",
  "scripts/security/formal-proof-pinned-suites.mjs",
  "scripts/security/formal-proof-source-selection.mjs",
  "scripts/security/formal-proof-spiffe-peer-domain.mjs",
  "scripts/security/formal-cargo-isolation.py",
  "scripts/security/formal-cargo-freshness.py",
  "scripts/security/formal-proof-push-gate-registry.mjs",
  "scripts/security/formal-proof-push-gate.mjs",
  "scripts/security/formal-proof-push-history.mjs",
  "scripts/security/formal-proof-remote-main.mjs",
  "scripts/security/map-composed-go-sarif.mjs",
  "scripts/audit/native-toolchain-sbom.py",
  "scripts/audit/new-helper.py",
  "scripts/test/live-turn/audit-crypto.sh",
  "scripts/test/live-turn/verify-crypto-subset.py",
  "scripts/test/live-turn/new-helper.py",
  "tools/pwa-tailscale-native-http/source.json",
  "packages/app-core/scripts/sops-oracle/oracle.mjs",
  "apps/android/scripts/build-core.sh",
  "crates/authenticator-core/src/bin/uniffi-bindgen.rs",
  "crates/authenticator-core/src/lib.rs",
  "crates/authenticator-core/src/new-boundary.rs",
  "apps/android/scripts/new-build-helper.py",
  "apps/android/scripts/required.test.sh",
  "packages/app-core/scripts/sops-oracle/runtime.test.mjs",
  "tools/pwa-tailscale-native-http/runtime.test.mjs",
  "apps/android/android/settings.gradle.kts",
  "apps/android/android/build.gradle.kts",
  "apps/android/android/app/build.gradle.kts",
  "apps/android/android/gradle.properties",
  "apps/android/android/app/new.gradle.kts",
  "apps/android/android/buildSrc/src/main/Injected.kt",
  "apps/android/android/gradle/verification-metadata.xml",
  "scripts/test/live-turn/go.mod",
  "scripts/test/live-turn/go.sum",
  "go.work",
  "scripts/test/live-turn/go.work",
  "scripts/test/live-turn/go.work.sum",
  "scripts/test/live-turn/third_party/x-crypto/go.mod",
  "Cargo.toml",
  "Cargo.lock",
  "crates/example/Cargo.toml",
  "crates/example/build.rs",
  "rust-toolchain.toml",
  "package-lock.json",
  "pnpm-workspace.yaml",
  "apps/example/package.json",
  "apps/example/.npmrc",
  "apps/example/.pnpmfile.cjs",
  "tools/pwa-tailscale-native-http/native-audit.mjs",
  "tools/pwa-tailscale-native-http/compose-native.mjs",
  "tools/pwa-tailscale-native-http/prepare-distribution.mjs",
  "tools/pwa-tailscale-native-http/new-helper.mjs",
  "scripts/security/gitleaks-reviewed-working-tree.json",
];

test("release formal tools fetch and verify the NATS pin before exporting it", (t) => {
  const work = mkdtempSync(join(tmpdir(), "formal-release-tools-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  const fixture = join(work, "scripts/mtls");
  mkdirSync(bin);
  mkdirSync(fixture, { recursive: true });
  const stub = (path, body) =>
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub(join(bin, "curl"), "exit 0");
  stub(join(bin, "sha256sum"), "cat >/dev/null; exit 0");
  stub(
    join(bin, "tar"),
    'd="$RUNNER_TEMP/release-tools/formal-proofs/lean-4.24.0-linux/bin"\nmkdir -p "$d"\nprintf "#!/bin/sh\\nexit 0\\n" > "$d/lean"\nchmod +x "$d/lean"',
  );
  for (const name of ["node", "npm", "rustc"]) stub(join(bin, name), "exit 0");
  stub(
    join(fixture, "mtls-fixtures.sh"),
    'printf "%s %s %s\\n" "$1" "$2" "$OPENSESAME_MTLS_FIXTURE_DIR" >> "$FIXTURE_LOG"\n[ "${MOCK_FIXTURE_FAIL:-}" != "$1" ]',
  );
  const script = fileURLToPath(new URL("./deep-tools.sh", import.meta.url));
  const ghEnv = join(work, "github-env");
  const log = join(work, "fixture-log");
  const fixtureDir = join(work, "release-tools/formal-proofs/mtls-fixtures");
  const run = (check, fail = "") => {
    writeFileSync(ghEnv, "");
    writeFileSync(log, "");
    return spawnSync("bash", [script, check], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: work,
        GITHUB_PATH: join(work, "github-path"),
        GITHUB_ENV: ghEnv,
        FIXTURE_LOG: log,
        MOCK_FIXTURE_FAIL: fail,
      },
    });
  };
  const success = run("formal-proofs");
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    `fetch nats-server ${fixtureDir}`,
    `verify nats-server ${fixtureDir}`,
  ]);
  assert.match(
    readFileSync(ghEnv, "utf8"),
    new RegExp(`^OPENSESAME_MTLS_FIXTURE_DIR=${fixtureDir}$`, "m"),
  );
  for (const failure of ["fetch", "verify"]) {
    assert.notEqual(run("formal-proofs", failure).status, 0, failure);
    assert.doesNotMatch(
      readFileSync(ghEnv, "utf8"),
      /^OPENSESAME_MTLS_FIXTURE_DIR=/m,
    );
  }
  assert.equal(run("shuttle").status, 0);
  assert.equal(readFileSync(log, "utf8"), "");
});

test("scanner configuration, ignores and helpers are part of policy compatibility", async () => {
  const controller = new Map(policies.map((path) => [path, `blob:${path}`]));
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  api.policyEntries = async () => policyEntriesForTree(controller);
  const expectedHash = await api.policyHash();
  for (const path of policies) {
    for (const value of [null, "changed"]) {
      const candidate = new Map(controller);
      if (value === null) candidate.delete(path);
      else candidate.set(path, value);
      api.tree = async () => candidate;
      assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
    }
  }
  api.tree = async () => new Map(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
  controller.set(".semgrepignore", "new-controller-policy");
  assert.notEqual(await api.policyHash(), expectedHash);
  for (const path of policies) {
    const without = new Map(controller);
    without.delete(path);
    api.policyEntries = async () => policyEntriesForTree(without);
    api.tree = async () => controller;
    assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
  }
  api.tree = async () => new Map([...controller, ["docs/unrelated.md", "new"]]);
  api.policyEntries = async () => policyEntriesForTree(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
});

test("missing required controller scanner configuration fails closed", async () => {
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  const required = [
    "tools/pwa-tailscale-native-http/source.json",
    "packages/app-core/scripts/sops-oracle/oracle.mjs",
    "apps/android/scripts/build-core.sh",
    "crates/authenticator-core/src/bin/uniffi-bindgen.rs",
    "crates/authenticator-core/src/lib.rs",
    "apps/android/android/settings.gradle.kts",
    "apps/android/android/build.gradle.kts",
    "apps/android/android/app/build.gradle.kts",
    "apps/android/android/gradle.properties",
    "scripts/test/live-turn/go.mod",
    "scripts/test/live-turn/go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "package-lock.json",
    "pnpm-workspace.yaml",
    ".github/codeql/codeql-config.yml",
    ".gitleaks.toml",
    ".cargo/audit.toml",
    "deny.toml",
    "osv-scanner.toml",
    "scripts/lib/dependency-compatibility.test.mjs",
    "scripts/fuzz/jazzer-gate.sh",
    "scripts/lib/fuzz-directory.sh",
    "scripts/mtls/mtls-fixtures.sh",
    "spec/formal/proof-registry.json",
    "spec/formal/proof-requirements.json",
    "spec/formal/check-axioms.sh",
    "spec/formal/check-axioms.test.mjs",
    "spec/formal/required-theorem-command.lean",
    "spec/formal/auth/AuthPolicy.lean",
    "spec/formal/auth/required-theorems.lean",
    "scripts/test/auth-formal.sh",
    "scripts/test/auth-formal-drift.mjs",
    "scripts/security/formal-proof-release-gate.mjs",
    "scripts/security/formal-proof-push-gate-registry.mjs",
    "scripts/security/formal-proof-required-suites.mjs",
    "scripts/security/formal-proof-pinned-suites.mjs",
    "scripts/security/formal-proof-source-selection.mjs",
    "scripts/security/formal-proof-spiffe-peer-domain.mjs",
    "scripts/security/formal-cargo-isolation.py",
    "scripts/security/formal-cargo-freshness.py",
    "scripts/security/formal-proof-push-gate.mjs",
    "scripts/security/formal-proof-push-history.mjs",
    "scripts/security/formal-proof-remote-main.mjs",
  ];
  const controller = new Map(
    [...CI_RECIPE, ...required].map((path) => [path, "blob"]),
  );
  api.tree = async () => controller;
  assert.ok((await api.policyEntries()).length >= 12);
  for (const path of required) {
    const incomplete = new Map(controller);
    incomplete.delete(path);
    api.tree = async () => incomplete;
    await assert.rejects(
      api.policyEntries(),
      /Current policy is incomplete/,
      path,
    );
  }
});

test("policy compatibility includes Git file modes and rejects policy symlinks", async () => {
  const path = ".gitleaks.toml";
  const sha = "a".repeat(40);
  const response = (mode) => ({
    ok: true,
    json: async () => ({
      truncated: false,
      tree: [{ path, sha, mode, type: "blob" }],
    }),
  });
  let mode = "100644";
  const api = new GitHub({ repository: POLICY.repository }, async () =>
    response(mode),
  );
  const original = await api.tree("a".repeat(40));
  api.policyEntries = async () => policyEntriesForTree(original);
  mode = "100755";
  assert.equal(await api.compatiblePolicy("b".repeat(40)), false);
  mode = "120000";
  await assert.rejects(api.tree("c".repeat(40)), /Invalid policy file mode/);
});

test("unrelated skill-package metadata is not executable extraction policy", () => {
  const path = ".claude/skills/scandinavian-design/scripts/package.json";
  assert.deepEqual(policyEntriesForTree(new Map([[path, "120000:blob"]])), []);
  assert.deepEqual(
    policyEntriesForTree(
      new Map([["apps/example/package.json", "100644:blob"]]),
    ),
    [["apps/example/package.json", "100644:blob"]],
  );
});

test("the formal push test fixture is excluded from executable policy", () => {
  assert.deepEqual(
    policyEntriesForTree(
      new Map([
        [
          "scripts/security/formal-proof-push-gate.test.fixture.mjs",
          "100644:blob",
        ],
      ]),
    ),
    [],
  );
});
