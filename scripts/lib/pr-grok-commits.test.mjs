import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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

  it("keeps the historical status context and runs agent attribution", () => {
    expect(workflow).toMatch(/^name: Grok signed commits$/m);
    expect(workflow).toMatch(/^ {4}name: Grok signed commits$/m);
    expect(workflow).toContain("scripts/release/check-pr-grok-commits.mjs");
  });

  it("reports the same result under the name the declared ruleset requires", () => {
    const jobs = parse(workflow).jobs;
    const declared = JSON.parse(
      readFileSync(
        new URL("../../ops/github/default-branch.json", import.meta.url),
        "utf8",
      ),
    )
      .rules.find((rule) => rule.type === "required_status_checks")
      .parameters.required_status_checks.map((check) => check.context);
    const names = Object.values(jobs).map((job) => job.name);
    // Both the historical name and the declared one are reported, so applying
    // the declared ruleset can never leave a required check pending.
    expect(names).toContain("Grok signed commits");
    expect(declared).toContain("Agent attribution");
    expect(names).toContain("Agent attribution");
    const mirror = jobs["agent-attribution"];
    expect(mirror.needs).toBe("grok-commits");
    // It runs even when the job it mirrors failed or was cancelled, for the
    // same pull requests, and passes only on that job's success.
    expect(mirror.if).toBe(`always() && (${jobs["grok-commits"].if})`);
    expect(mirror.permissions).toEqual({});
    expect(mirror.steps).toHaveLength(1);
    expect(mirror.steps[0].env).toEqual({
      RESULT: "${{ needs.grok-commits.result }}",
    });
    expect(mirror.steps[0].run).toBe('[ "$RESULT" = success ]');
  });
});
