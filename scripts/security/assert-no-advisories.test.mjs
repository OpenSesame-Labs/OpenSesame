import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attestRepairedFindings } from "./assert-no-advisories.mjs";

const gate = fileURLToPath(
  new URL("./assert-no-advisories.mjs", import.meta.url),
);
const root = resolve(dirname(gate), "../..");
const exactFinding = Object.freeze({
  id: "GHSA-fc5q-39xc-vjpf",
  ecosystem: "npm",
  package: "picomatch",
  version: "2.3.2",
  source: join(root, "package-lock.json"),
});
const repairedTuples = [
  ["GHSA-3g3m-2fjr-6pw4", "glob", "10.5.0"],
  ["GHSA-3g3m-2fjr-6pw4", "glob", "11.1.0"],
  ["GHSA-g3hv-75wg-m249", "minimatch", "9.0.9"],
  ["GHSA-g3hv-75wg-m249", "minimatch", "10.2.6"],
  ["GHSA-fc5q-39xc-vjpf", "picomatch", "2.3.2"],
  ["GHSA-fc5q-39xc-vjpf", "picomatch", "4.0.7"],
];
function repairedFindings(directory = root) {
  return repairedTuples.map(([id, packageName, version]) => ({
    id,
    ecosystem: "npm",
    package: packageName,
    version,
    source: join(directory, "package-lock.json"),
  }));
}
function runReport(contents) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-advisory-gate-"));
  try {
    const report = join(directory, "findings.json");
    writeFileSync(report, contents, { mode: 0o600 });
    const result = spawnSync(process.execPath, [gate, report], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("empty scanner findings pass", () => {
  const result = runReport("[]");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CLEAN/);
});

test("every advisory fails, including former backport exceptions", () => {
  for (const finding of [
    {
      id: "GHSA-vfj7-8cjw-p6xm",
      ecosystem: "npm",
      package: "braces",
      version: "3.0.3",
    },
    {
      id: "GHSA-86w9-cpqp-85rv",
      ecosystem: "npm",
      package: "node-forge",
      version: "1.4.0",
    },
    {
      id: "OSV-unrecognized",
      ecosystem: "unknown",
      package: "other",
      version: "1",
    },
    null,
  ]) {
    const result = runReport(JSON.stringify([finding]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
    assert.doesNotMatch(result.stdout, /CLEAN/);
  }
});

test("malformed and missing reports fail closed", () => {
  for (const contents of ["", "{", "null", "{}", '"[]"', "false"]) {
    const result = runReport(contents);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
  for (const args of [[], ["/no/such/opensesame-findings.json"]]) {
    const result = spawnSync(process.execPath, [gate, ...args], {
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
});

test("the exact repaired advisory tuples pass their complete attestation", () => {
  const findings = repairedFindings();
  const directory = mkdtempSync(join(tmpdir(), "opensesame-attestation-"));
  try {
    const report = join(directory, "findings.json");
    writeFileSync(report, JSON.stringify(findings), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [gate, report, "--attest-repaired", root],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /6 exact repaired findings attested/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new IDs, tuple drift, duplicate findings and a foreign lock fail", () => {
  for (const finding of [
    { ...exactFinding, id: "GHSA-new" },
    { ...exactFinding, version: "2.3.3" },
    { ...exactFinding, package: "other" },
    { ...exactFinding, source: "/tmp/foreign/package-lock.json" },
  ]) {
    assert.throws(() =>
      attestRepairedFindings(root, [finding], { execute: () => {} }),
    );
  }
  assert.throws(() =>
    attestRepairedFindings(root, [exactFinding, exactFinding], {
      execute: () => {},
    }),
  );
  assert.throws(() =>
    attestRepairedFindings(root, repairedFindings().slice(1), {
      execute: () => {},
    }),
  );
});

const fixtureFiles = [
  "package.json",
  "package-lock.json",
  "patches/vendor/manifest.json",
  "patches/glob@10.5.0.patch",
  "patches/glob@11.1.0.patch",
  "patches/minimatch@9.0.9.patch",
  "patches/minimatch@10.2.6.patch",
  "patches/picomatch@2.3.2.patch",
  "patches/picomatch@4.0.7.patch",
  "patches/vendor/glob-10.5.0.tgz",
  "patches/vendor/glob-11.1.0.tgz",
  "patches/vendor/minimatch-9.0.9.tgz",
  "patches/vendor/minimatch-10.2.6.tgz",
  "patches/vendor/picomatch-2.3.2.tgz",
  "patches/vendor/picomatch-4.0.7.tgz",
  "scripts/security/dependency-override-upgrade.test.mjs",
  "scripts/security/removed-dependencies.test.mjs",
  "scripts/security/picomatch-backport.test.mjs",
  "scripts/security/patched-dependencies.mjs",
];

function driftFixture(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "opensesame-attestation-drift-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const relative of fixtureFiles) {
    const destination = join(directory, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, relative), destination);
  }
  assert.doesNotThrow(() =>
    attestRepairedFindings(directory, repairedFindings(directory), {
      execute: () => {},
    }),
  );
  return directory;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("patch, tarball, upstream source and named-test drift fail closed", (t) => {
  for (const mutate of [
    (directory) =>
      appendFileSync(join(directory, "patches/picomatch@2.3.2.patch"), "\n"),
    (directory) =>
      appendFileSync(
        join(directory, "patches/vendor/picomatch-2.3.2.tgz"),
        "drift",
      ),
    (directory) => {
      const path = join(directory, "patches/vendor/manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.vendored["picomatch@2.3.2"].upstreamFileMapSha256 = "0".repeat(
        64,
      );
      writeJson(path, manifest);
    },
    (directory) =>
      rmSync(join(directory, "scripts/security/picomatch-backport.test.mjs")),
  ]) {
    const directory = driftFixture(t);
    mutate(directory);
    assert.throws(() =>
      attestRepairedFindings(directory, repairedFindings(directory), {
        execute: () => {},
      }),
    );
  }
});

test("lock integrity, missing occurrences and override range drift fail closed", (t) => {
  for (const mutate of [
    (directory) => {
      const path = join(directory, "package-lock.json");
      const lock = JSON.parse(readFileSync(path, "utf8"));
      const entry = Object.values(lock.packages).find(
        (item) => item.name === "picomatch" && item.version === "2.3.2",
      );
      entry.integrity = `sha512-${"A".repeat(88)}`;
      writeJson(path, lock);
    },
    (directory) => {
      const path = join(directory, "package-lock.json");
      const lock = JSON.parse(readFileSync(path, "utf8"));
      for (const [location, entry] of Object.entries(lock.packages))
        if (entry.name === "picomatch" && entry.version === "2.3.2")
          delete lock.packages[location];
      writeJson(path, lock);
    },
    (directory) => {
      const path = join(directory, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.overrides["picomatch@^2"] = "4.0.7";
      writeJson(path, manifest);
    },
  ]) {
    const directory = driftFixture(t);
    mutate(directory);
    assert.throws(() =>
      attestRepairedFindings(directory, repairedFindings(directory), {
        execute: () => {},
      }),
    );
  }
});
