import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("production federated pending cookies", () => {
  it("always signs encodePending with claimPepper at route call sites", () => {
    for (const rel of ["src/routes/interactions.ts", "src/routes/interactions-byo.ts"]) {
      const source = readFileSync(`${root}/${rel}`, "utf8");
      expect(source).not.toMatch(/encodePending\(\s*pending\s*\)/);
      expect(source).toMatch(
        /encodePending\([^,]+,\s*ctx\.config\.claimPepper\)/,
      );
    }
  });
});
