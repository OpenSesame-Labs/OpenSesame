import { expect, it } from "vitest";
import { TOKEN as TOKEN_PATTERN } from "./native-tailscale-api.js";
import {
  assertSyntheticTailscaleToken,
  syntheticTailscaleApiKey,
  syntheticTailscaleAuthKey,
  syntheticTailscaleClientKey,
} from "./synthetic-tailscale-key.js";

const gateHref = new URL(
  "../../../../scripts/security/tailscale-key-material-gate.mjs",
  import.meta.url,
).href;

it("mints synthetic Tailscale keys that satisfy the production format check", () => {
  for (const value of [
    syntheticTailscaleApiKey(),
    syntheticTailscaleClientKey(),
    syntheticTailscaleAuthKey(),
  ]) {
    assertSyntheticTailscaleToken(value);
    expect(value).toMatch(TOKEN_PATTERN);
  }
});

it("keeps Tailscale key material out of tracked source, docs, and spec", async () => {
  // SAFETY: dynamic import boundary; the gate module's contract exports this scanner.
  const gate = (await import(gateHref)) as {
    findTailscaleKeyMaterialViolations: () => string[];
  };
  const violations = gate.findTailscaleKeyMaterialViolations();
  expect(violations, violations.join("\n")).toEqual([]);
});
