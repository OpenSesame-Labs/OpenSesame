import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitCandidateSource, main } from "./admit-candidate-source.mjs";

const SHA = "a".repeat(40);
const onMain = (status = "ahead", behind = 0, base = SHA) => ({
  status,
  behind_by: behind,
  merge_base_commit: { sha: base },
});

test("admits a full SHA that is the default branch or one of its ancestors", () => {
  for (const status of ["ahead", "identical"])
    assert.equal(
      admitCandidateSource({
        candidate: SHA,
        defaultBranch: "main",
        compare: onMain(status),
      }),
      SHA,
    );
});

test("refuses abbreviated, ref-shaped and non-hex sources before any lookup", () => {
  for (const candidate of [
    "a".repeat(39),
    "A".repeat(40),
    "refs/heads/main",
    `${SHA}\nrevision=${"b".repeat(40)}`,
    undefined,
  ])
    assert.throws(() =>
      admitCandidateSource({
        candidate,
        defaultBranch: "main",
        compare: onMain(),
      }),
    );
});

test("refuses a fork or unmerged commit that is not on the default branch", () => {
  for (const compare of [
    onMain("diverged", 3, "c".repeat(40)),
    onMain("behind", 2),
    onMain("ahead", 0, "c".repeat(40)),
    onMain("ahead", 1),
    {},
    undefined,
  ])
    assert.throws(
      () =>
        admitCandidateSource({
          candidate: SHA,
          defaultBranch: "main",
          compare,
        }),
      /not on main/,
    );
});

test("writes only the admitted revision output and asks GitHub about the default branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "admit-candidate-"));
  try {
    const output = join(dir, "output");
    const asked = [];
    const request = (path) => {
      asked.push(path);
      return path.includes("/compare/") ? onMain() : { default_branch: "main" };
    };
    const env = {
      GITHUB_REPOSITORY: "owner/repo",
      REQUESTED_SOURCE: SHA,
      GITHUB_OUTPUT: output,
    };
    assert.equal(main(env, request), SHA);
    assert.deepEqual(asked, [
      "repos/owner/repo",
      `repos/owner/repo/compare/${SHA}...main?per_page=1`,
    ]);
    assert.equal(readFileSync(output, "utf8"), `revision=${SHA}\n`);
    assert.throws(() =>
      main({ ...env, REQUESTED_SOURCE: "main" }, () => {
        throw new Error("must not be asked");
      }),
    );
    assert.throws(() => main({ ...env, GITHUB_OUTPUT: "" }, request));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
