import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyFormalVitestReport } from "./formal-vitest-report.mjs";
import { fixture, root } from "./formal-vitest-report-fixtures.mjs";

for (const suite of ["auth", "oauth", "webauthn"]) {
  test(`${suite}: complete report and vector matrix passes`, () => {
    const { report, vectors } = fixture(suite);
    assert.doesNotThrow(() =>
      verifyFormalVitestReport(suite, report, vectors, root),
    );
  });

  test(`${suite}: a skipped correspondence case fails even if totals claim success`, () => {
    const { report, vectors } = fixture(suite);
    const cases = report.testResults[0].assertionResults;
    const target =
      suite === "auth"
        ? cases.find((item) => item.title.startsWith("session "))
        : suite === "oauth"
          ? cases.find((item) => item.title.startsWith("current provenance "))
          : cases.find((item) => item.title.startsWith("approval "));
    target.status = "pending";
    assert.throws(() => verifyFormalVitestReport(suite, report, vectors, root));
  });

  test(`${suite}: renaming a required comparison fails with unchanged totals`, () => {
    const { report, vectors } = fixture(suite);
    const cases = report.testResults[0].assertionResults;
    const target =
      suite === "auth"
        ? cases.find((item) => item.title.startsWith("project "))
        : suite === "oauth"
          ? cases.find((item) => item.title.startsWith("legacy provenance "))
          : cases.find((item) => item.title.startsWith("approval "));
    target.title = `renamed ${target.title}`;
    target.fullName = [...target.ancestorTitles, target.title].join(" ");
    assert.throws(() => verifyFormalVitestReport(suite, report, vectors, root));
  });

  test(`${suite}: a missing or duplicated vector fails`, () => {
    const { report, vectors } = fixture(suite);
    const lines = vectors.trimEnd().split("\n");
    assert.throws(() =>
      verifyFormalVitestReport(
        suite,
        report,
        `${lines.slice(1).join("\n")}\n`,
        root,
      ),
    );
    lines[0] = lines[1];
    assert.throws(() =>
      verifyFormalVitestReport(suite, report, `${lines.join("\n")}\n`, root),
    );
  });

  test(`${suite}: malformed modeled outputs fail`, () => {
    const { report, vectors } = fixture(suite);
    const positions =
      suite === "auth"
        ? { principal: [2], session: [7], project: [5, 6, 7, 8] }
        : suite === "oauth"
          ? { legacy: [5], provenance: [5] }
          : { approval: [6] };
    for (const [group, indexes] of Object.entries(positions)) {
      for (const index of indexes) {
        const lines = vectors.trimEnd().split("\n");
        const row = lines.findIndex((line) => line.startsWith(`${group}\t`));
        const fields = lines[row].split("\t");
        fields[index] = "bogus";
        lines[row] = fields.join("\t");
        assert.throws(
          () =>
            verifyFormalVitestReport(
              suite,
              report,
              `${lines.join("\n")}\n`,
              root,
            ),
          /invalid output/,
        );
      }
    }
  });

  test(`${suite}: an empty report fails through the CLI`, () => {
    const directory = mkdtempSync(join(tmpdir(), "formal-vitest-report-"));
    try {
      const { vectors } = fixture(suite);
      const reportPath = join(directory, "report.json");
      const vectorsPath = join(directory, "vectors.tsv");
      writeFileSync(reportPath, "");
      writeFileSync(vectorsPath, vectors);
      const cli = resolve(root, "scripts/test/formal-vitest-report.mjs");
      const link = join(directory, "verifier.mjs");
      symlinkSync(cli, link);
      for (const entry of [cli, link]) {
        const result = spawnSync(
          process.execPath,
          [entry, suite, reportPath, vectorsPath, root],
          { encoding: "utf8" },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /formal-vitest-report:/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("oauth: a skipped security test cannot hide behind passing counts", () => {
  const { report, vectors } = fixture("oauth");
  report.testResults[1].assertionResults[0].status = "pending";
  assert.throws(() => verifyFormalVitestReport("oauth", report, vectors, root));
});

test("auth: every generated comparison group is required", () => {
  for (const prefix of ["session ", "principal ", "project "]) {
    const { report, vectors } = fixture("auth");
    const target = report.testResults[0].assertionResults.find((item) =>
      item.title.startsWith(prefix),
    );
    target.status = "pending";
    assert.throws(() =>
      verifyFormalVitestReport("auth", report, vectors, root),
    );
  }
});

test("auth: repeated comparisons cannot substitute for distinct cases", () => {
  const { report, vectors } = fixture("auth");
  const tests = report.testResults[0].assertionResults;
  for (const prefix of ["session ", "project "]) {
    const cases = tests.filter((item) => item.title.startsWith(prefix));
    const original = { ...cases[1] };
    Object.assign(cases[1], cases[0]);
    assert.throws(() =>
      verifyFormalVitestReport("auth", report, vectors, root),
    );
    Object.assign(cases[1], original);
  }
});

test("webauthn: repeated comparisons cannot substitute for distinct cases", () => {
  const { report, vectors } = fixture("webauthn");
  const cases = report.testResults[0].assertionResults.filter((item) =>
    item.title.startsWith("approval "),
  );
  Object.assign(cases[1], cases[0]);
  assert.throws(() =>
    verifyFormalVitestReport("webauthn", report, vectors, root),
  );
});

test("oauth: both generated comparison groups are required", () => {
  for (const prefix of ["legacy provenance ", "current provenance "]) {
    const { report, vectors } = fixture("oauth");
    const target = report.testResults[0].assertionResults.find((item) =>
      item.title.startsWith(prefix),
    );
    target.status = "pending";
    assert.throws(() =>
      verifyFormalVitestReport("oauth", report, vectors, root),
    );
  }
});

test("oauth: a duplicated file cannot replace the required security file", () => {
  const { report, vectors } = fixture("oauth");
  report.testResults[1] = structuredClone(report.testResults[0]);
  assert.throws(() => verifyFormalVitestReport("oauth", report, vectors, root));
});

test("malformed and unsuccessful reports fail closed", () => {
  const { report, vectors } = fixture("auth");
  assert.throws(() => verifyFormalVitestReport("auth", {}, vectors, root));
  assert.throws(() =>
    verifyFormalVitestReport(
      "auth",
      { ...report, success: false },
      vectors,
      root,
    ),
  );
  assert.throws(() =>
    verifyFormalVitestReport("unknown", report, vectors, root),
  );
});

test("non-string report fields and vector input fail closed", () => {
  for (const field of ["title", "fullName", "ancestorTitles", "fileName"]) {
    const { report, vectors } = fixture("auth");
    const file = report.testResults[0];
    const assertion = file.assertionResults[0];
    if (field === "fileName") file.name = 42;
    else if (field === "ancestorTitles") assertion.ancestorTitles = [42];
    else assertion[field] = 42;
    assert.throws(() =>
      verifyFormalVitestReport("auth", report, vectors, root),
    );
  }
  const { report } = fixture("auth");
  assert.throws(() => verifyFormalVitestReport("auth", report, null, root));
});
