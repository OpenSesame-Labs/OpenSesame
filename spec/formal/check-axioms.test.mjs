import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const lean = process.env.OPENSESAME_LEAN_BIN || "lean";
const suites = [
  {
    name: "auth",
    model: "AuthPolicy.lean",
    first: "missing_principal_denied",
    vectors: 408,
  },
  {
    name: "authority",
    model: "Authority.lean",
    first: "export_cannot_escalate",
    vectors: 50,
  },
  {
    name: "dpop",
    model: "ReplayPolicy.lean",
    first: "insertion_retains_until_valid_end",
    vectors: 9216,
  },
  {
    name: "source-lifetime",
    model: "SourceLifetime.lean",
    first: "claim_quarantines",
    vectors: 33,
  },
  {
    name: "source-trust-selection",
    model: "SourceTrustSelection.lean",
    first: "stale_view_is_refused",
    vectors: 32,
  },
  {
    name: "spiffe-peer-domain",
    model: "SpiffePeerDomain.lean",
    first: "untrusted_chain_refused",
    vectors: 16,
  },
  {
    name: "spiffe",
    model: "SpiffePolicy.lean",
    first: "no_identity_withdraws",
    vectors: 473,
  },
  {
    name: "webauthn",
    model: "ApprovalBinding.lean",
    first: "approved_proof_matches_request",
    vectors: 6144,
  },
  {
    name: "interaction-clock",
    model: "InteractionClock.lean",
    first: "live_refines_policy",
    vectors: 252,
  },
  {
    name: "oauth",
    model: "PendingIntegrity.lean",
    first: "current_message_binds_payload",
    vectors: 113,
  },
];

// Each fixture contains just one suite. This also checks that earlier stacked
// PRs do not need files from suites introduced by later PRs.
function fixture(suite) {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-proof-check-"));
  const formal = join(dir, "spec/formal");
  const suiteDir = join(formal, suite.name);
  mkdirSync(suiteDir, { recursive: true });
  for (const file of ["check-axioms.sh", "required-theorem-command.lean"]) {
    copyFileSync(join(root, "spec/formal", file), join(formal, file));
  }
  for (const file of [suite.model, "required-theorems.lean"]) {
    copyFileSync(
      join(root, "spec/formal", suite.name, file),
      join(suiteDir, file),
    );
  }
  return {
    dir,
    runner: join(formal, "check-axioms.sh"),
    model: join(suiteDir, suite.model),
    obligations: join(suiteDir, "required-theorems.lean"),
  };
}

function runCheck(files) {
  const result = spawnSync("bash", [files.runner, lean, files.model], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function expectFailure(result, diagnostic) {
  assert.notEqual(
    result.status,
    0,
    "checker unexpectedly accepted the mutation",
  );
  assert.equal(
    result.stdout,
    "",
    "failed checks must not emit partial vectors",
  );
  assert.match(result.stderr, diagnostic);
}

for (const suite of suites) {
  const modelPath = join(root, "spec/formal", suite.name, suite.model);
  const obligationsPath = join(
    root,
    "spec/formal",
    suite.name,
    "required-theorems.lean",
  );
  // Later stacked PRs introduce the other suites. A partial suite fails closed.
  if (
    suite.name !== "auth" &&
    !existsSync(modelPath) &&
    !existsSync(obligationsPath)
  )
    continue;
  test(`${suite.name} checks each required theorem and its pinned type`, () => {
    const files = fixture(suite);
    try {
      const original = readFileSync(files.model, "utf8");
      const originalTheorem = new RegExp(
        `\\btheorem\\s+${suite.first}\\b`,
        "u",
      );
      assert.match(original, originalTheorem);
      const accepted = runCheck(files);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout.trimEnd().split("\n").length, suite.vectors);

      writeFileSync(
        files.model,
        original.replace(originalTheorem, `theorem ${suite.first}_removed`),
      );
      expectFailure(
        runCheck(files),
        /required theorem missing or not a theorem/u,
      );

      writeFileSync(
        files.model,
        original.replace(
          originalTheorem,
          `theorem ${suite.first} : True := True.intro\n\ntheorem ${suite.first}_original`,
        ),
      );
      expectFailure(runCheck(files), /type mismatch/iu);
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });
}

test("the checker rejects missing, duplicate, or empty obligations", () => {
  const files = fixture(suites[0]);
  try {
    const obligations = readFileSync(files.obligations, "utf8");
    writeFileSync(files.obligations, "");
    expectFailure(runCheck(files), /expected 19 required theorems, checked 0/u);
    writeFileSync(files.obligations, obligations);
    const first = obligations.indexOf("#require_theorem ");
    const second = obligations.indexOf("#require_theorem ", first + 1);
    assert.ok(first >= 0 && second > first);
    writeFileSync(
      files.obligations,
      obligations.slice(0, first) + obligations.slice(second),
    );
    expectFailure(
      runCheck(files),
      /expected 19 required theorems, checked 18/u,
    );
    writeFileSync(
      files.obligations,
      obligations.replace("principalVerdict none = .notFound", "_"),
    );
    expectFailure(runCheck(files), /unresolved metavariables in requirement/u);
    writeFileSync(
      files.obligations,
      obligations + obligations.slice(first, second),
    );
    expectFailure(runCheck(files), /already been declared/u);
    rmSync(files.obligations);
    expectFailure(runCheck(files), /required-theorems\.lean/u);
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("proof coercions cannot disguise a weakened theorem type", () => {
  const files = fixture(suites[0]);
  try {
    const original = readFileSync(files.model, "utf8");
    const weakened = `theorem missing_principal_denied : True := True.intro
instance : Coe True (principalVerdict none = .notFound) where
  coe _ := rfl
theorem missing_principal_denied_original`;
    writeFileSync(
      files.model,
      original.replace("theorem missing_principal_denied", weakened),
    );
    expectFailure(runCheck(files), /required theorem type mismatch/u);
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("the checker rejects axioms, sorry, and non-theorem replacements", () => {
  const files = fixture(suites[0]);
  try {
    const original = readFileSync(files.model, "utf8");
    for (const invalid of [
      "axiom invented : False\ntheorem falsehood : False := invented\n",
      "theorem falsehood : False := by sorry\n",
    ]) {
      writeFileSync(files.model, `${original}\n${invalid}`);
      expectFailure(
        runCheck(files),
        /unapproved axiom|declaration uses 'sorry'/u,
      );
    }
    writeFileSync(
      files.model,
      original.replace(
        "theorem missing_principal_denied",
        "def missing_principal_denied",
      ),
    );
    expectFailure(
      runCheck(files),
      /required theorem missing or not a theorem/u,
    );
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
});
