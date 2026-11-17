import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateJar } from "../../apps/pages/scripts/verify-ui-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const original = readFileSync(
  join(directory, "FederatedTrustBinding.tla"),
  "utf8",
);

function counterexample(invariant, model = original) {
  const jar = process.env.TLA2TOOLS_JAR;
  validateJar(jar);
  const scratch = mkdtempSync(
    join(tmpdir(), "opensesame-trust-binding-fault-"),
  );
  try {
    writeFileSync(join(scratch, "FederatedTrustBinding.tla"), model);
    writeFileSync(
      join(scratch, "FederatedTrustBinding.cfg"),
      `SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT ${invariant}\n`,
    );
    const result = spawnSync(
      "java",
      [
        "-XX:+UseParallelGC",
        "-Xmx2g",
        "-cp",
        resolve(jar),
        "tlc2.TLC",
        "-workers",
        "1",
        "-metadir",
        join(scratch, "state"),
        "-config",
        "FederatedTrustBinding.cfg",
        "FederatedTrustBinding.tla",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, "the negative control must fail");
    assert.ok(output.includes(`Invariant ${invariant} is violated`));
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mutate(before, after) {
  assert.equal(original.split(before).length, 2, "mutation must match once");
  return original.replace(before, after);
}

test("a matching organization flow can complete", () => {
  assert.match(counterexample("MatchingAcceptanceUnreachable"), /<Complete/);
});

test("an organization-to-visitor rebound is rejected", () => {
  assert.match(counterexample("ReboundRejectionUnreachable"), /<Complete/);
});

test("omitting source binding admits a different authority", () => {
  const mutant = mutate(
    "exact == startedSource = currentSource /\\ startedId = currentId",
    "exact == startedId = currentId",
  );
  assert.match(counterexample("AcceptedSourceBound", mutant), /<Complete/);
});

test("omitting record identity admits a replacement record", () => {
  const mutant = mutate(
    "exact == startedSource = currentSource /\\ startedId = currentId",
    "exact == startedSource = currentSource",
  );
  assert.match(counterexample("AcceptedIdBound", mutant), /<Complete/);
});

test("allowing legacy dynamic trust grants new authority", () => {
  const mutant = mutate(
    'legacy == startedSource = "legacy" /\\ currentSource = "static"',
    'legacy == startedSource = "legacy"',
  );
  assert.match(
    counterexample("LegacyCannotGainDynamicTrust", mutant),
    /<Complete/,
  );
});

test("omitting pending-kind binding admits an OAuth2 cookie to OIDC", () => {
  const mutant = mutate(
    'pendingKind = "oidc" /\\ currentKind = "oidc"',
    'currentKind = "oidc"',
  );
  assert.match(counterexample("AcceptedPendingIsOidc", mutant), /<Complete/);
});

test("omitting authority-kind binding admits an OAuth2 provider", () => {
  const mutant = mutate(
    'pendingKind = "oidc" /\\ currentKind = "oidc"',
    'pendingKind = "oidc"',
  );
  assert.match(counterexample("AcceptedAuthorityIsOidc", mutant), /<Complete/);
});

test("omitting provenance cardinality admits ambiguous authority", () => {
  const mutant = mutate(
    "                       /\\ provenanceCount <= 1 /\\ (exact \\/ legacy)",
    "                       /\\ (exact \\/ legacy)",
  );
  assert.match(
    counterexample("AcceptedHasSingleProvenance", mutant),
    /<Complete/,
  );
});
