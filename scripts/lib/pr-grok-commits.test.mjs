import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";
import { assertPrGrokCommits } from "./pr-grok-commits.mjs";

const head = "a".repeat(40);

function commit(sha, verified, name, email) {
  return {
    sha,
    commit: {
      author: { name, email },
      verification: { verified },
    },
  };
}

describe("assertPrGrokCommits", () => {
  it("accepts verified Grok-authored commits", () => {
    const commits = [commit(head, true, "Grok", "noreply@x.ai")];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head }, commits: 1 }, commits, head),
    ).not.toThrow();
  });

  it("accepts verified replay with Grok co-author trailer", () => {
    const commits = [
      {
        sha: head,
        commit: {
          author: { name: "cursor[bot]", email: "noreply@cursor.com" },
          message: `headline\n\n${grokCoAuthorTrailer()}`,
          verification: { verified: true },
        },
      },
    ];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head }, commits: 1 }, commits, head),
    ).not.toThrow();
  });

  it("rejects verified commits without Grok attribution", () => {
    const commits = [commit(head, true, "cursor[bot]", "noreply@cursor.com")];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head }, commits: 1 }, commits, head),
    ).toThrow(/Grok-attributed commits required/);
  });

  it("rejects unsigned Grok author", () => {
    const commits = [commit(head, false, "Grok", "noreply@x.ai")];
    expect(() =>
      assertPrGrokCommits({ head: { sha: head }, commits: 1 }, commits, head),
    ).toThrow(/Verified signatures required/);
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
    expect(workflow).not.toContain("49933ea5286caeca1862841ea589338350501966");
  });
});
