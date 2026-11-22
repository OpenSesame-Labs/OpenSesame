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
  it("seals the verifier unless the env flag is an explicit false", () => {
    expect(loadConfig(productionEnv).federatedPendingSealVerifierOnWire).toBe(
      true,
    );
    expect(
      loadConfig({
        ...productionEnv,
        OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER: "false",
      }).federatedPendingSealVerifierOnWire,
    ).toBe(false);
    expect(
      loadConfig({
        ...productionEnv,
        OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER: "0",
      }).federatedPendingSealVerifierOnWire,
    ).toBe(false);
  });

  it("always signs encodePending with claimPepper at route call sites", () => {
    for (const rel of [
      "src/routes/interactions.ts",
      "src/routes/interactions-byo.ts",
    ]) {
      const source = readFileSync(`${root}/${rel}`, "utf8");
      expect(source).not.toMatch(/encodePending\(\s*pending\s*\)/);
      expect(source).toMatch(
        /encodePending\([^,]+,\s*ctx\.config\.claimPepper,/,
      );
      expect(source).toMatch(
        /sealVerifierOnWire:\s*ctx\.config\.federatedPendingSealVerifierOnWire/,
      );
    }
  });
});
