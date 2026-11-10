import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";
import { assertPrGrokCommits } from "./pr-grok-commits.mjs";

const head = "a".repeat(40);

function commit(sha, verified, name, email, message) {
  return {
    sha,
    commit: {
      author: { name, email },
      message: message ?? `headline\n\n${grokCoAuthorTrailer()}`,
      verification: { verified },
    },
  };
}

describe("assertPrGrokCommits (compat)", () => {
  it("accepts verified Grok replay with co-author trailer", () => {
    const commits = [
      commit(
        head,
        true,
        "cursor[bot]",
        "206951365+cursor[bot]@users.noreply.github.com",
      ),
    ];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head } }, commits, head),
    ).not.toThrow();
  });

  it("accepts Claude without Grok trailer", () => {
    const commits = [
      commit(
        head,
        true,
        "Claude",
        "noreply@anthropic.com",
        "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ),
    ];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head } }, commits, head),
    ).not.toThrow();
  });
});

describe("ci-grok-commits workflow", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci-grok-commits.yml", import.meta.url),
    "utf8",
  );

  it("pins setup-node to the published v5.0.0 commit", () => {
    expect(workflow).toContain(
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0",
    );
  });

  it("keeps the live ruleset status context and runs agent attribution", () => {
    expect(workflow).toMatch(/^name: Grok signed commits$/m);
    expect(workflow).toMatch(/^ {4}name: Grok signed commits$/m);
    expect(workflow).toContain("scripts/release/check-pr-grok-commits.mjs");
    expect(workflow).not.toContain("name: Agent attribution");
  });
});
