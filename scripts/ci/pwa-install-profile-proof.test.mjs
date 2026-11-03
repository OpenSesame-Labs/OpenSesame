import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("install profile proof can consume a prebuilt dist directory", () => {
  const source = readFileSync(
    new URL("./pwa-install-profile-proof.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /PWA_PROFILE_PROOF_DIST/);
  assert.match(source, /VERIFY_SKIP_BUILD/);
});
