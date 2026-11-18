import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  activationDeadlineError,
  isLiveAt,
} from "../../../packages/control-plane/src/services/interaction-clock.js";

it("matches Lean's finite and invalid date boundary vectors", () => {
  const path = process.env.OPENSESAME_INTERACTION_CLOCK_VECTORS;
  if (!path) throw new Error("Lean vectors are required");
  const rows = readFileSync(path, "utf8").trim().split("\n");
  expect(rows).toHaveLength(252);
  const activationRows = rows.filter((row) => row.startsWith("activation\t"));
  const instantRows = rows.filter((row) => !row.startsWith("activation\t"));
  expect(activationRows).toHaveLength(216);
  expect(instantRows).toHaveLength(36);
  for (const row of instantRows) {
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
  for (const row of activationRows) {
    const [
      ,
      interactionValid,
      interaction,
      activationValid,
      activation,
      nowValid,
      now,
      expected,
    ] = row.split("\t");
    for (const value of [
      interactionValid,
      activationValid,
      nowValid,
      expected,
    ]) {
      expect(["true", "false"]).toContain(value);
    }
    const interactionDeadline = new Date(
      interactionValid === "true" ? Number(interaction) : Number.NaN,
    );
    const activationDeadline = new Date(
      activationValid === "true" ? Number(activation) : Number.NaN,
    );
    const sampledAt = new Date(nowValid === "true" ? Number(now) : Number.NaN);
    const error = activationDeadlineError(
      interactionDeadline,
      activationDeadline,
      sampledAt,
    );
    expect(error === undefined, row).toBe(expected === "true");
    if (!isLiveAt(interactionDeadline, sampledAt))
      expect(error, row).toBe("interaction_expired");
    else if (!isLiveAt(activationDeadline, sampledAt))
      expect(error, row).toBe("activation_expired");
  }
});
