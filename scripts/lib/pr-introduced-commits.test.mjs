import { describe, expect, it } from "vitest";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";
import { loadPrIntroducedCommits } from "./pr-introduced-commits.mjs";
import { assertPrGrokCommits } from "./pr-grok-commits.mjs";

const head = "a".repeat(40);
const staleBase = "b".repeat(40);
const mainMerge = "c".repeat(40);
const mainMerge2 = "d".repeat(40);

function verifiedCommit(sha, name, email, message = "subject") {
  return {
    sha,
    commit: {
      author: { name, email },
      message,
      verification: { verified: true },
    },
  };
}

describe("loadPrIntroducedCommits", () => {
  it("uses compare baseRef...head and rejects incomplete pages", () => {
    const calls = [];
    const api = (path, paginate) => {
      calls.push({ path, paginate });
      if (path.startsWith("repos/o/r/pulls/1")) {
        return {
          head: { sha: head },
          base: { ref: "main", sha: staleBase },
          commits: 99,
        };
      }
      if (path.startsWith("repos/o/r/compare/main...")) {
        return paginate
          ? [{ commits: [verifiedCommit(head, "Grok", "noreply@x.ai")], total_commits: 1 }]
          : undefined;
      }
      throw new Error(`unexpected api ${path}`);
    };
    const { commits, baseRef } = loadPrIntroducedCommits("o/r", 1, head, api);
    expect(baseRef).toBe("main");
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe(head);
    expect(calls.some((c) => c.path.includes("compare/main..."))).toBe(true);
    expect(calls.some((c) => c.path.includes("/commits"))).toBe(false);
  });
});

describe("stale PR base vs introduced commits", () => {
  it("ignores main-only commits that pulls/commits would include", () => {
    const pullsWouldList = [
      verifiedCommit(staleBase, "human", "human@example.com"),
      verifiedCommit(mainMerge, "human", "human@example.com"),
      verifiedCommit(mainMerge2, "human", "human@example.com"),
      verifiedCommit(head, "cursor[bot]", "noreply@cursor.com", `fix\n\n${grokCoAuthorTrailer()}`),
    ];
    const introducedOnly = [pullsWouldList.at(-1)];
    const pr = { head: { sha: head }, base: { ref: "main", sha: staleBase }, commits: 4 };
    expect(() =>
      assertPrGrokCommits(pr, pullsWouldList, head),
    ).toThrow(/Grok-attributed commits required/);
    expect(() => assertPrGrokCommits(pr, introducedOnly, head)).not.toThrow();
  });

  it("still rejects an unsigned introduced commit", () => {
    const pr = { head: { sha: head }, base: { ref: "main", sha: staleBase } };
    const bad = [
      {
        sha: head,
        commit: {
          author: { name: "human", email: "human@example.com" },
          verification: { verified: false },
        },
      },
    ];
    expect(() => assertPrGrokCommits(pr, bad, head)).toThrow(/Verified signatures required/);
  });
});
