import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGrokSignedRevisionRange,
  parseGithubOwnerRepo,
  parseSignatureLogLine,
} from "../dev/grok-commit-guard.mjs";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";

const sha = "a".repeat(40);
const hookSource = readFileSync(
  new URL("../../.githooks-grok/pre-push", import.meta.url),
  "utf8",
);

function replay(message, verified = true) {
  return {
    sha,
    commit: {
      author: { name: "cursor[bot]", email: "noreply@cursor.com" },
      message,
      verification: { verified },
    },
  };
}

function git(dir, args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "grok-guard-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function divergedRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "noreply@x.ai"]);
  git(dir, ["config", "user.name", "Grok"]);
  git(dir, ["commit", "--allow-empty", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-b", "hand"]);
  git(dir, ["commit", "--allow-empty", "-m", "hand"]);
  const hand = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-b", "feature", base]);
  git(dir, ["commit", "--allow-empty", "-m", "branch"]);
  const local = git(dir, ["rev-parse", "HEAD"]);
  return { base, hand, local };
}

/**
 * The product hook cds into the OpenSesame checkout and then runs the real
 * guard, so this fixture copies the hook into a throwaway repo and stubs the
 * guard. That records the range without GitHub. A full push of this checkout
 * is the heavy path and is not what this test runs.
 */
function pushHook(dir, stdin) {
  const hookDir = join(dir, ".githooks-grok");
  const guardDir = join(dir, "scripts", "dev");
  const rangePath = join(dir, "range.txt");
  mkdirSync(hookDir, { recursive: true });
  mkdirSync(guardDir, { recursive: true });
  const hookPath = join(hookDir, "pre-push");
  writeFileSync(hookPath, hookSource);
  chmodSync(hookPath, 0o755);
  writeFileSync(
    join(guardDir, "grok-commit-guard.mjs"),
    `import { writeFileSync } from "node:fs";
const flag = process.argv.indexOf("--range");
writeFileSync(${JSON.stringify(rangePath)}, process.argv[flag + 1] ?? "");
`,
  );
  const result = spawnSync(hookPath, {
    cwd: dir,
    encoding: "utf8",
    input: stdin,
  });
  return { result, rangePath };
}

function cases() {
  return [
    [
      "parses git log signature lines",
      () => {
        assert.deepEqual(parseSignatureLogLine(`${sha} G noreply@x.ai`), {
          sha,
          signature: "G",
          authorEmail: "noreply@x.ai",
        });
      },
    ],
    [
      "rejects the old signature line that omitted the commit id",
      () => {
        assert.throws(
          () => parseSignatureLogLine("G noreply@x.ai"),
          /invalid signature log line/,
        );
      },
    ],
    [
      "accepts a locally signed Grok commit without calling GitHub",
      () => {
        assert.doesNotThrow(() =>
          assertGrokSignedRevisionRange([`${sha} G noreply@x.ai`, ""], () => {
            throw new Error("lookup should not run");
          }),
        );
      },
    ],
    [
      "accepts a GitHub-verified replay line whose local signature is E",
      () => {
        const line = `${sha} E noreply@cursor.com`;
        assert.doesNotThrow(() =>
          assertGrokSignedRevisionRange([line], () =>
            replay(`headline\n\n${grokCoAuthorTrailer()}`),
          ),
        );
      },
    ],
    [
      "rejects a verified commit that is not Grok-attributed",
      () => {
        assert.throws(
          () =>
            assertGrokSignedRevisionRange([`${sha} E noreply@cursor.com`], () =>
              replay("headline"),
            ),
          /not Grok-attributed/,
        );
      },
    ],
    [
      "rejects a Grok-attributed commit GitHub has not verified",
      () => {
        assert.throws(
          () =>
            assertGrokSignedRevisionRange([`${sha} E noreply@cursor.com`], () =>
              replay(`headline\n\n${grokCoAuthorTrailer()}`, false),
            ),
          /not verified/,
        );
      },
    ],
    [
      "rejects when the GitHub lookup fails",
      () => {
        assert.throws(
          () =>
            assertGrokSignedRevisionRange(
              [`${sha} E noreply@cursor.com`],
              () => {
                throw new Error("gh down");
              },
            ),
          /GitHub verification lookup failed \(gh down\)/,
        );
      },
    ],
    [
      "resolves owner/repo from origin without keeping userinfo",
      () => {
        assert.equal(
          parseGithubOwnerRepo("git@github.com:OpenSesame-Labs/OpenSesame.git"),
          "OpenSesame-Labs/OpenSesame",
        );
        assert.equal(
          parseGithubOwnerRepo(
            "https://x-access-token:secret@github.com/OpenSesame-Labs/OpenSesame.git",
          ),
          "OpenSesame-Labs/OpenSesame",
        );
        assert.equal(
          parseGithubOwnerRepo(
            "ssh://git@github.com/OpenSesame-Labs/OpenSesame.git",
          ),
          "OpenSesame-Labs/OpenSesame",
        );
        assert.throws(
          () => parseGithubOwnerRepo("https://user:secret@gitlab.com/a/b.git"),
          (error) => {
            assert.match(error.message, /cannot resolve owner\/repo/);
            assert.equal(error.message.includes("secret"), false);
            return true;
          },
        );
      },
    ],
    [
      "pre-push uses the merge-base range and still refuses *-signed",
      () => {
        assert.match(
          hookSource,
          /BASE="\$\(git merge-base "\$remote_sha" "\$local_sha"\)"/,
        );
        assert.match(hookSource, /RANGE="\$BASE\.\.\$local_sha"/);
        assert.match(hookSource, /RANGE="origin\/main\.\.\$local_sha"/);
        assert.doesNotMatch(hookSource, /RANGE="\$remote_sha\.\.\$local_sha"/);
        assert.match(hookSource, /refs\/heads\/\*-signed/);
        assert.match(hookSource, /refuses direct git push/);

        withRepo((dir) => {
          const { base, hand, local } = divergedRepo(dir);
          const updated = pushHook(
            dir,
            `refs/heads/feature ${local} refs/heads/feature ${hand}\n`,
          );
          assert.equal(updated.result.status, 0, updated.result.stderr);
          assert.equal(
            readFileSync(updated.rangePath, "utf8"),
            `${base}..${local}`,
          );
          assert.notEqual(base, hand);
          const subjects = git(dir, [
            "log",
            "--format=%s",
            `${base}..${local}`,
          ]);
          assert.equal(subjects, "branch");

          const created = pushHook(
            dir,
            `refs/heads/feature ${local} refs/heads/feature ${"0".repeat(40)}\n`,
          );
          assert.equal(created.result.status, 0, created.result.stderr);
          assert.equal(
            readFileSync(created.rangePath, "utf8"),
            `origin/main..${local}`,
          );

          rmSync(created.rangePath);
          const signed = pushHook(
            dir,
            `refs/heads/feature-signed ${local} refs/heads/feature-signed ${hand}\n`,
          );
          assert.notEqual(signed.result.status, 0);
          assert.match(signed.result.stderr, /refuses direct git push/);
          assert.equal(existsSync(signed.rangePath), false);
        });
      },
    ],
  ];
}

if (process.env.NODE_TEST_CONTEXT !== undefined) {
  const { test } = await import("node:test");
  for (const [name, fn] of cases()) {
    test(name, fn);
  }
} else {
  const { describe, it } = await import("vitest");
  describe("grok-commit-guard", () => {
    for (const [name, fn] of cases()) {
      it(name, fn);
    }
  });
}
