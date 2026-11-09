import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";
import { commitAttributesGrok } from "./pr-grok-commits.mjs";
import { assertPrSignatures } from "./pr-signatures.mjs";

const head = "a".repeat(40);
const pr = { head: { sha: head }, commits: 1 };

function commit(verified, name, email, message = "headline") {
  return {
    sha: head,
    commit: {
      author: { name, email },
      message,
      verification: { verified },
    },
  };
}

describe("commitAttributesGrok (the Grok replay tool's own check)", () => {
  it("recognises the Grok author", () => {
    expect(commitAttributesGrok(commit(true, "Grok", "noreply@x.ai"))).toBe(
      true,
    );
  });

  it("recognises the Grok co-author trailer on a replayed commit", () => {
    const replayed = commit(
      true,
      "cursor[bot]",
      "noreply@cursor.com",
      `headline\n\n${grokCoAuthorTrailer()}`,
    );
    expect(commitAttributesGrok(replayed)).toBe(true);
  });

  it("does not recognise a commit that does not involve Grok", () => {
    expect(
      commitAttributesGrok(commit(true, "Someone", "someone@example.com")),
    ).toBe(false);
  });
});

describe("the pull-request commit gate", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci-grok-commits.yml", import.meta.url),
    "utf8",
  );

  it("accepts a verified commit that has nothing to do with Grok", () => {
    const commits = [commit(true, "Claude", "noreply@anthropic.com")];
    expect(() => assertPrSignatures(pr, commits, head)).not.toThrow();
  });

  it("still rejects an unsigned commit, whoever wrote it", () => {
    for (const [name, email] of [
      ["Grok", "noreply@x.ai"],
      ["Someone", "someone@example.com"],
    ]) {
      expect(() =>
        assertPrSignatures(pr, [commit(false, name, email)], head),
      ).toThrow(/Verified signatures required/);
    }
  });

  it("runs the signature check, not an attribution check", () => {
    expect(workflow).toContain("scripts/release/check-pr-signatures.mjs");
    expect(workflow).not.toMatch(/grok-commits\.mjs/);
  });

  it("keeps the status context the branch ruleset requires by name", () => {
    expect(workflow).toMatch(/^name: Grok signed commits$/m);
    expect(workflow).toMatch(/^ {4}name: Grok signed commits$/m);
  });

  it("pins setup-node to the published v5.0.0 commit", () => {
    expect(workflow).toContain(
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0",
    );
    expect(workflow).not.toContain("49933ea5286caeca1862841ea589338350501966");
  });
});
