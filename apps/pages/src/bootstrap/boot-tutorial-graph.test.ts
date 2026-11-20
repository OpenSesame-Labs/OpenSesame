import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "boot.ts",
);

describe("core boot graph", () => {
  it("does not static-import the tutorial presenter on the boot graph", () => {
    const src = readFileSync(bootPath, "utf8");
    expect(src).not.toMatch(/^import[^;]*tutorial-queue-present/m);
    expect(src).toMatch(
      /import\s*\(\s*["']@opensesame\/app-core\/lib\/tutorial-queue-present\.js["']\s*\)/,
    );
  });
});
