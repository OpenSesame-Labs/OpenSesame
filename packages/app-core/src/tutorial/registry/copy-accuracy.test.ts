import { describe, expect, it } from "vitest";
import { AUTHORED_GUIDE_TARGETS, AUTHORED_HELP_TOPICS } from "./authored.js";
import { CONNECTIONS_GOALS } from "./connections-goals.js";

function answer(id: string): string {
  const topic = AUTHORED_HELP_TOPICS.find((item) => item.id === id);
  expect(topic, id).toBeDefined();
  return topic?.answer ?? "";
}

describe("tutorial copy accuracy", () => {
  it("describes backup recovery using the vault's enrolled method", () => {
    expect(answer("help.backup")).toContain("existing unlock method");
    expect(answer("help.backup")).not.toMatch(/master password/i);
  });

  it("gives the same Tailnet pairing location as the guide", () => {
    expect(answer("help.tailnet-sync")).toContain("Settings → Features");
    expect(answer("help.tailnet-sync")).not.toContain("Settings → Vaults");
    const guide =
      CONNECTIONS_GOALS.find((goal) => goal.id === "settings.tailnet-sync")
        ?.guide ?? "";
    expect(guide).toContain('navigate "/settings/features/networking"');
    expect(guide).not.toContain("with its password");
  });

  it("does not require a mouse for password health", () => {
    expect(answer("help.health")).toContain("Password health");
    expect(answer("help.health")).not.toMatch(/right.click/i);
  });

  it("uses direct names for setup and actions throughout the target catalog", () => {
    for (const target of AUTHORED_GUIDE_TARGETS) {
      expect(target.description, target.id).not.toMatch(
        /\b(?:ink square|guest road|sign-in roads|front door's|skippable)\b/i,
      );
    }
  });
});
