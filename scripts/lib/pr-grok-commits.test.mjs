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
  it("pins setup-node to the published v5.0.0 commit", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci-grok-commits.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain(
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0",
    );
    expect(workflow).toContain("name: Agent attribution");
  });
});
