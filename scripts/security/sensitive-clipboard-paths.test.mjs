import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url);
const sensitiveCopySurfaces = [
  "apps/pages/src/sections/settings/security/SecondStepCeremonies.tsx",
  "apps/pages/src/sections/settings/security/AccountTotpCeremony.tsx",
  "apps/pages/src/sections/connections/secret-backends/SecretBackendItemFields.tsx",
  "apps/pages/src/sections/settings/plugins/HoneyTokensPanel.tsx",
  "apps/pages/src/sections/vault/EnvironmentFields.tsx",
];

test("sensitive copy surfaces use the lock-aware clipboard coordinator", () => {
  for (const path of sensitiveCopySurfaces) {
    const source = readFileSync(new URL(path, ROOT), "utf8");
    assert.match(source, /useCopySecret/u, `${path} bypasses useCopySecret`);
    assert.doesNotMatch(
      source,
      /navigator\.clipboard(?:\?)?\.writeText/u,
      `${path} writes a sensitive value directly to the clipboard`,
    );
  }
});
