import { describe, expect, it } from "vitest";
import {
  assertGrokSignedRevisionRange,
  parseSignatureLogLine,
} from "../dev/grok-commit-guard.mjs";

describe("grok-commit-guard parsing", () => {
  it("parses git log signature lines", () => {
    expect(parseSignatureLogLine("G noreply@x.ai")).toEqual({
      signature: "G",
      authorEmail: "noreply@x.ai",
    });
  });

  it("accepts a signed Grok commit line", () => {
    expect(() =>
      assertGrokSignedRevisionRange(["G noreply@x.ai", ""]),
    ).not.toThrow();
  });

  it("accepts a signed Claude author and rejects an unrecognised author", () => {
    expect(() =>
      assertGrokSignedRevisionRange(["G noreply@anthropic.com"]),
    ).not.toThrow();
    expect(() =>
      assertGrokSignedRevisionRange(["G human@example.com"]),
    ).toThrow(/Agent attribution required/);
  });
});
