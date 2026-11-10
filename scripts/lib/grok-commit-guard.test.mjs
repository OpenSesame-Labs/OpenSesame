import { describe, expect, it } from "vitest";
import {
  assertGrokSignedRevisionRange,
  parseSignatureLogLine,
} from "../dev/grok-commit-guard.mjs";

/** Signature log lines are parsed at the boundary, then checked as records. */
function parsedSignatureLines(lines) {
  const commits = [];
  for (const line of lines) {
    const parsed = parseSignatureLogLine(line);
    if (parsed !== undefined) {
      commits.push(parsed);
    }
  }
  return commits;
}

describe("grok-commit-guard parsing", () => {
  it("parses git log signature lines", () => {
    expect(parseSignatureLogLine("G noreply@x.ai")).toEqual({
      signature: "G",
      authorEmail: "noreply@x.ai",
    });
  });

  it("accepts a signed Grok commit line", () => {
    expect(() =>
      assertGrokSignedRevisionRange(
        parsedSignatureLines(["G noreply@x.ai", ""]),
      ),
    ).not.toThrow();
  });

  it("accepts a signed Claude author and rejects an unrecognised author", () => {
    expect(() =>
      assertGrokSignedRevisionRange(
        parsedSignatureLines(["G noreply@anthropic.com"]),
      ),
    ).not.toThrow();
    expect(() =>
      assertGrokSignedRevisionRange(
        parsedSignatureLines(["G human@example.com"]),
      ),
    ).toThrow(/Agent attribution required/);
  });
});
