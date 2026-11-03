import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const FILES = [
  ".github/workflows/cd-npm-cli.yml",
  ".github/workflows/cd-pwa.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-advisory.yml",
  ".github/workflows/candidate-build.yml",
  ".github/workflows/ci-coverage.yml",
  ".github/workflows/ci-prerelease-checks.yml",
  ".github/workflows/ci-release-checks.yml",
  ".github/workflows/complete-verify.yml",
  ".github/workflows/security.yml",
];

function git(cwd, args, env = {}) {
  return spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("full-history checkouts are blobless", () => {
  it("pairs every fetch-depth 0 with filter blob:none in the ten workflows", () => {
    let sites = 0;
    for (const file of FILES) {
      const lines = readFileSync(join(repoRootFromHere(), file), "utf8").split(
        "\n",
      );
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^(\s*)fetch-depth: 0\s*$/.exec(lines[index]);
        if (!match) continue;
        sites += 1;
        expect(lines[index + 1], `${file}:${index + 1}`).toBe(
          `${match[1]}filter: blob:none`,
        );
      }
    }
    expect(sites).toBe(17);
  });

  it("keeps ancestry, name-only diffs, and a clean worktree without historical blobs", () => {
    const source = mkdtempSync(join(tmpdir(), "blobless-src-"));
    const origin = mkdtempSync(join(tmpdir(), "blobless-origin-"));
    const clone = mkdtempSync(join(tmpdir(), "blobless-clone-"));
    try {
      git(source, ["init", "-q", "--initial-branch=main"]);
      git(source, ["config", "user.email", "ci@example.com"]);
      git(source, ["config", "user.name", "CI"]);
      writeFileSync(join(source, "a.txt"), "one\n");
      git(source, ["add", "a.txt"]);
      git(source, ["commit", "-q", "-m", "first"]);
      writeFileSync(join(source, "a.txt"), "two\n");
      writeFileSync(join(source, "b.txt"), "added\n");
      git(source, ["add", "a.txt", "b.txt"]);
      git(source, ["commit", "-q", "-m", "second"]);
      git(source, ["clone", "--bare", source, origin]);
      git(origin, ["config", "uploadpack.allowFilter", "true"]);
      const cloned = git(clone, [
        "clone",
        "--filter=blob:none",
        `file://${origin}`,
        "repo",
      ]);
      expect(cloned.status, cloned.stderr).toBe(0);
      const repo = join(clone, "repo");
      const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
      const base = git(repo, ["rev-parse", "HEAD~1"]).stdout.trim();
      expect(
        git(repo, ["merge-base", "--is-ancestor", base, head]).status,
      ).toBe(0);
      expect(
        git(repo, ["rev-list", "--count", `${base}..${head}`]).stdout.trim(),
      ).toBe("1");
      expect(
        git(repo, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          `${base}...${head}`,
        ])
          .stdout.split("\0")
          .filter(Boolean)
          .sort(),
      ).toEqual(["a.txt", "b.txt"]);
      expect(git(repo, ["diff", "--exit-code"]).status).toBe(0);
      expect(git(repo, ["diff", "--cached", "--exit-code"]).status).toBe(0);
      expect(git(repo, ["log", "-1", "--format=%ct"]).stdout.trim()).toMatch(
        /^\d+$/,
      );
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
      const historical = git(repo, ["cat-file", "-e", `${base}:a.txt`], {
        GIT_NO_LAZY_FETCH: "1",
      });
      expect(historical.status).not.toBe(0);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
