import { describe, expect, it } from "vitest";
import { loadPrIntroducedCommits } from "./pr-introduced-commits.mjs";

const head = "a".repeat(40);

describe("loadPrIntroducedCommits", () => {
  it("uses compare baseRef...head", () => {
    const calls = [];
    const api = (path, paginate) => {
      calls.push({ path, paginate });
      if (path.includes("/pulls/")) {
        return {
          head: { sha: head },
          base: { ref: "main", sha: "c".repeat(40) },
        };
      }
      if (path.includes("compare/main...")) {
        return [{ commits: [{ sha: head }], total_commits: 1 }];
      }
      throw new Error(path);
    };
    const { commits } = loadPrIntroducedCommits("o/r", 9, head, api);
    expect(commits).toHaveLength(1);
    expect(calls.some((c) => c.path.includes("compare/main..."))).toBe(true);
  });
});
