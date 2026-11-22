/** @vitest-environment jsdom */
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { expect, it, vi } from "vitest";
import {
  FIRST_VAULT_PACK_GUIDE,
  FIRST_VAULT_SHELL_GUIDE,
  firstVaultGateGuide,
  firstVaultSignInGuide,
} from "./first-vault-guide.js";
import { guideGoalIds } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import * as state from "./state.js";
import { guideTargetIds } from "./targets.js";

function liveVocabulary() {
  return {
    goals: guideGoalIds(),
    targets: guideTargetIds(),
    routes: mergedGuideRoutes().map((route) => route.id),
    predicates: state.guidePredicateIds(),
  };
}

it("compiles every first-vault continuation against the live catalog", () => {
  registerGuidePredicates();
  const revoke = registerTutorialRealm();
  try {
    for (const source of [
      // jsdom has no WebAuthn, so both compose the PIN road.
      firstVaultGateGuide(),
      FIRST_VAULT_SHELL_GUIDE,
      FIRST_VAULT_PACK_GUIDE,
      firstVaultSignInGuide(),
    ]) {
      expect(
        compileGuide(source, liveVocabulary(), AUTHORED_GUIDE_LIMITS),
      ).toMatchObject({ ok: true });
    }
  } finally {
    revoke();
  }
});

it("leads with a passkey and names PIN only as the PRF fallback", () => {
  expect(firstVaultGateGuide()).toContain("Seal with passkey");
  expect(firstVaultGateGuide()).toContain(
    "If it fails or is unavailable, select PIN.",
  );
  expect(firstVaultGateGuide()).not.toContain('focus "unlock.seal-pin"');
  expect(firstVaultGateGuide()).toContain('focus "unlock.seal-actions"');
  expect(firstVaultSignInGuide()).toContain('focus "unlock.local-only"');
  expect(FIRST_VAULT_SHELL_GUIDE).toContain('focus "editor.generate-password"');
  expect(FIRST_VAULT_SHELL_GUIDE).toContain('focus "item.copy-generated"');
});

it("walks the seal road each browser can take, on both guides", () => {
  registerGuidePredicates();
  const revoke = registerTutorialRealm();
  const known = vi.spyOn(state, "isKnownGuidePredicate").mockReturnValue(true);
  const read = vi.spyOn(state, "readGuidePredicate");
  try {
    const vocabulary = liveVocabulary();

    // The passkey road: the seal step holds until the vault is unlocked and
    // never waits for a PIN entry that road does not draw.
    read.mockReturnValue(true);
    for (const [name, guide] of [
      ["gate", firstVaultGateGuide()],
      ["sign-in", firstVaultSignInGuide()],
    ] as const) {
      expect(guide, name).toContain("Seal with passkey");
      expect(guide, name).toContain(
        "If it fails or is unavailable, select PIN.",
      );
      expect(guide, name).toContain('focus "unlock.seal-actions"');
      expect(guide, name).toContain('wait state "vault.unlocked" is=true');
      expect(guide, name).not.toContain('wait target "unlock.seal-pin-entry"');
      expect(guide, name).not.toContain('focus "unlock.seal-pin-entry"');
      expect(guide, name).not.toContain('focus "unlock.seal-pin-confirm"');
      expect(
        compileGuide(guide, vocabulary, AUTHORED_GUIDE_LIMITS),
        name,
      ).toMatchObject({ ok: true });
    }

    // The PIN fallback road: the PIN entry is the step's move, then the four
    // fields walk before the vault is unlocked.
    read.mockReturnValue(false);
    for (const [name, guide] of [
      ["gate", firstVaultGateGuide()],
      ["sign-in", firstVaultSignInGuide()],
    ] as const) {
      expect(guide, name).toContain('focus "unlock.seal-actions"');
      expect(guide, name).toContain(
        'wait target "unlock.seal-pin-entry" event=appear',
      );
      expect(guide, name).toContain('focus "unlock.seal-pin-entry"');
      expect(guide, name).toContain('focus "unlock.seal-pin-confirm"');
      expect(guide, name).toContain('focus "unlock.seal-ack"');
      expect(guide, name).toContain('focus "unlock.seal"');
      expect(guide, name).toContain('wait state "vault.unlocked" is=true');
      expect(
        compileGuide(guide, vocabulary, AUTHORED_GUIDE_LIMITS),
        name,
      ).toMatchObject({ ok: true });
    }
  } finally {
    known.mockRestore();
    read.mockRestore();
    revoke();
  }
});
