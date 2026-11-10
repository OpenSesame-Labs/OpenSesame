import { describe, expect, it } from "vitest";
import {
  assertCommitAgentAttribution,
  commitClaimsGrok,
  grokVerifiedReplayAttribution,
  recognizedAgentId,
} from "./agent-commit-attribution.mjs";
import { grokCoAuthorTrailer } from "./grok-commit-identity.mjs";
import { assertPrAgentAttribution } from "./pr-agent-attribution.mjs";

const head = "a".repeat(40);
const staleMain = "b".repeat(40);

function commit(sha, verified, name, email, message = "subject") {
  return {
    sha,
    commit: {
      author: { name, email },
      message,
      verification: { verified },
    },
  };
}

describe("recognizedAgentId", () => {
  it("accepts Claude author and session", () => {
    const claude = commit(
      head,
      true,
      "Claude",
      "noreply@anthropic.com",
      "fix\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x",
    );
    expect(recognizedAgentId(claude)).toBe("claude");
    expect(
      recognizedAgentId(
        commit(head, true, "agent", "noreply@anthropic.com", "fix"),
      ),
    ).toBe("claude");
  });

  it("accepts Tyler", () => {
    expect(
      recognizedAgentId(
        commit(
          head,
          true,
          "Tyler Kendrick",
          "145080887+Tyler-R-Kendrick@users.noreply.github.com",
        ),
      ),
    ).toBe("tyler");
  });

  it("accepts Grok co-author on cursor replay", () => {
    const replay = commit(
      head,
      true,
      "cursor[bot]",
      "206951365+cursor[bot]@users.noreply.github.com",
      `fix\n\n${grokCoAuthorTrailer()}`,
    );
    expect(recognizedAgentId(replay)).toBe("grok");
    expect(grokVerifiedReplayAttribution(replay)).toBe(true);
  });
});

describe("assertCommitAgentAttribution", () => {
  it("rejects commits without attribution", () => {
    expect(() =>
      assertCommitAgentAttribution(
        commit(head, true, "random", "human@example.com"),
      ),
    ).toThrow(/Agent attribution required/);
  });

  it("rejects false Grok claims without proof", () => {
    expect(() =>
      assertCommitAgentAttribution(
        commit(
          head,
          true,
          "human",
          "human@example.com",
          `oops\n\n${grokCoAuthorTrailer()}`,
        ),
      ),
    ).toThrow(/Grok attribution requires Grok Build proof/);
  });

  it("accepts a verified replay under Tyler's account, and not an unverified one", () => {
    const tyler = "145080887+Tyler-R-Kendrick@users.noreply.github.com";
    const message = `fix\n\n${grokCoAuthorTrailer()}`;
    // land-signed-stack run with Tyler's token: author is Tyler, and
    // signed-replay.mjs has appended the Grok trailer.
    expect(() =>
      assertCommitAgentAttribution(
        commit(head, true, "Tyler Kendrick", tyler, message),
      ),
    ).not.toThrow();
    // The display name alone is not enough: the id-bound address is required.
    expect(() =>
      assertCommitAgentAttribution(
        commit(head, true, "Tyler Kendrick", "human@example.com", message),
      ),
    ).toThrow(/Grok attribution requires Grok Build proof/);
    expect(() =>
      assertCommitAgentAttribution(
        commit(head, false, "Tyler Kendrick", tyler, message),
      ),
    ).toThrow(/Grok attribution requires Grok Build proof/);
  });

  it("accepts Grok claim with chunk-run proof", () => {
    expect(() =>
      assertCommitAgentAttribution(
        commit(
          head,
          true,
          "human",
          "human@example.com",
          `fix\n\n${grokCoAuthorTrailer()}\n\nGrok-Build: work/grok-logs/slice.log`,
        ),
      ),
    ).not.toThrow();
  });
});

describe("assertPrAgentAttribution", () => {
  it("ignores main-only commits that pulls/commits would list", () => {
    const introduced = [
      commit(
        head,
        true,
        "Claude",
        "noreply@anthropic.com",
        "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ),
    ];
    const pullsNoise = [
      commit(staleMain, true, "merge", "human@example.com"),
      commit(
        head,
        true,
        "Claude",
        "noreply@anthropic.com",
        "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ),
    ];
    const pr = { head: { sha: head } };
    expect(() => assertPrAgentAttribution(pr, pullsNoise, head)).toThrow(
      /Agent attribution required/,
    );
    expect(() => assertPrAgentAttribution(pr, introduced, head)).not.toThrow();
  });

  it("rejects unsigned introduced commits", () => {
    const pr = { head: { sha: head } };
    expect(() =>
      assertPrAgentAttribution(
        pr,
        [commit(head, false, "Claude", "noreply@anthropic.com")],
        head,
      ),
    ).toThrow(/Verified signatures required/);
  });
});

describe("commitClaimsGrok", () => {
  it("detects trailer without requiring other agents to claim Grok", () => {
    const claudeOnly = commit(head, true, "Claude", "noreply@anthropic.com");
    expect(commitClaimsGrok(claudeOnly)).toBe(false);
    expect(recognizedAgentId(claudeOnly)).toBe("claude");
  });
});
