import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "boot.ts",
);

describe("core boot graph", () => {
  it("does not import the tutorial presenter before capability activation", () => {
    const src = readFileSync(bootPath, "utf8");
    expect(src).not.toContain("tutorial-queue-present");
  });
});