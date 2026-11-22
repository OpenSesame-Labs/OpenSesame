import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attestRepairedFindings } from "./assert-no-advisories.mjs";

const gate = fileURLToPath(
  new URL("./assert-no-advisories.mjs", import.meta.url),
);
const root = resolve(dirname(gate), "../..");
const formerBackports = [
  ["GHSA-3g3m-2fjr-6pw4", "glob", "10.5.0"],
  ["GHSA-3g3m-2fjr-6pw4", "glob", "11.1.0"],
  ["GHSA-g3hv-75wg-m249", "minimatch", "9.0.9"],
  ["GHSA-g3hv-75wg-m249", "minimatch", "10.2.6"],
].map(([id, packageName, version]) => ({
  id,
  ecosystem: "npm",
  package: packageName,
  version,
  source: join(root, "package-lock.json"),
}));

function runReport(contents, args = []) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-advisory-gate-"));
  try {
    const report = join(directory, "findings.json");
    writeFileSync(report, contents, { mode: 0o600 });
    const result = spawnSync(process.execPath, [gate, report, ...args], {
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
  for (const args of [[], ["--attest-repaired", root]]) {
    const result = runReport("[]", args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLEAN \(no findings\)/);
  }
  const cveLite = runReport(
    JSON.stringify({ findingCount: 0, findings: [] }),
    ["--attest-repaired", root],
  );
  assert.equal(cveLite.status, 0, cveLite.stderr);
  assert.match(cveLite.stdout, /CLEAN \(no findings\)/);
});

test("every advisory fails, including former backport exceptions", () => {
  for (const finding of [
    ...formerBackports,
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
      id: "GHSA-fc5q-39xc-vjpf",
      ecosystem: "npm",
      package: "picomatch",
      version: "2.3.2",
      source: join(root, "package-lock.json"),
    },
    {
      id: "OSV-unrecognized",
      ecosystem: "unknown",
      package: "other",
      version: "1",
    },
    null,
  ]) {
    for (const args of [[], ["--attest-repaired", root]]) {
      const result = runReport(JSON.stringify([finding]), args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FAIL/);
      assert.doesNotMatch(result.stdout, /CLEAN/);
    }
    assert.throws(() => attestRepairedFindings(root, [finding]));
  }
  assert.throws(
    () => attestRepairedFindings(root, formerBackports),
    /unattested advisory tuple: GHSA-3g3m-2fjr-6pw4 glob@10\.5\.0/,
  );
});

test("cve-lite findings fail in the attestation mode", () => {
  const result = runReport(
    JSON.stringify({
      findingCount: 1,
      findings: [
        {
          package: "minimatch",
          version: "9.0.9",
          vulnerabilities: [{ id: "GHSA-g3hv-75wg-m249" }],
        },
      ],
    }),
    ["--attest-repaired", root],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unattested advisory tuple: GHSA-g3hv-75wg-m249/);
});

test("malformed and missing reports fail closed", () => {
  for (const contents of ["", "{", "null", "{}", '"[]"', "false"]) {
    for (const args of [[], ["--attest-repaired", root]]) {
      const result = runReport(contents, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FAIL/);
    }
  }
  for (const contents of [
    JSON.stringify({ findingCount: 1, findings: [] }),
    JSON.stringify({ findingCount: 1, findings: [null] }),
  ]) {
    const result = runReport(contents, ["--attest-repaired", root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
  for (const args of [
    [],
    ["/no/such/opensesame-findings.json"],
    ["/no/such/opensesame-findings.json", "--attest-repaired", root],
  ]) {
    const result = spawnSync(process.execPath, [gate, ...args], {
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
  const unknownMode = runReport("[]", ["--other", root]);
  assert.equal(unknownMode.status, 1);
  const missingRoot = runReport("[]", ["--attest-repaired", "/no/such/root"]);
  assert.equal(missingRoot.status, 1);
});
