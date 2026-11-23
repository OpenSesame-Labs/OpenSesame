import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

const productionEnv = {
  OPENSESAME_ENV: "production",
  NODE_ENV: "production",
  OPENSESAME_CLAIM_PEPPER: "unique-claim-pepper-not-dev",
  OPENSESAME_OPERATOR_TOKEN: "operator-secret",
  OPENSESAME_CORS_ORIGINS: "https://app.example",
};

describe("production federated pending cookies", () => {
  it("has no switch that puts a plaintext verifier on the wire", () => {
    // v4 always seals the verifier; the v3 rollout flag is gone, so setting
    // the old variable changes nothing.
    const config = loadConfig({
      ...productionEnv,
      OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER: "false",
    });
    expect(config).not.toHaveProperty("federatedPendingSealVerifierOnWire");
    expect(config.claimPepper).toBe(productionEnv.OPENSESAME_CLAIM_PEPPER);
  });

  it("always signs encodePending with claimPepper at route call sites", () => {
    for (const rel of [
      "src/routes/interactions.ts",
      "src/routes/interactions-byo.ts",
    ]) {
      const source = readFileSync(`${root}/${rel}`, "utf8");
      expect(source).not.toMatch(/encodePending\(\s*pending\s*\)/);
      expect(source).toMatch(
        /encodePending\(\s*pending,\s*ctx\.config\.claimPepper\s*\)/,
      );
      expect(source).not.toMatch(/sealVerifierOnWire/);
    }
  });
});
