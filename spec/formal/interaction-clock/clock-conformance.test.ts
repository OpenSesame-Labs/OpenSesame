import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { isLiveAt } from "../../../packages/control-plane/src/services/interaction-clock.js";

it("matches Lean's finite and invalid date boundary vectors", () => {
  const path = process.env.OPENSESAME_INTERACTION_CLOCK_VECTORS;
  if (!path) throw new Error("Lean vectors are required");
  const rows = readFileSync(path, "utf8").trim().split("\n");
  expect(rows).toHaveLength(36);
  for (const row of rows) {
    const [deadlineValid, deadline, nowValid, now, expected] = row.split("\t");
    expect(["true", "false"]).toContain(deadlineValid);
    expect(["true", "false"]).toContain(nowValid);
    expect(["true", "false"]).toContain(expected);
    const expiresAt = new Date(
      deadlineValid === "true" ? Number(deadline) : Number.NaN,
    );
    const sampledAt = new Date(nowValid === "true" ? Number(now) : Number.NaN);
    expect(isLiveAt(expiresAt, sampledAt), row).toBe(expected === "true");
  }
});
