/** @vitest-environment jsdom */
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { expect, it, vi } from "vitest";
import {
  FIRST_VAULT_GATE_GUIDE,
  FIRST_VAULT_PACK_GUIDE,
  FIRST_VAULT_SHELL_GUIDE,
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
      FIRST_VAULT_GATE_GUIDE,
      FIRST_VAULT_SHELL_GUIDE,
      FIRST_VAULT_PACK_GUIDE,
      // jsdom has no WebAuthn, so this composes the PIN road.
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
  expect(FIRST_VAULT_GATE_GUIDE).toContain("Seal with passkey");
  expect(FIRST_VAULT_GATE_GUIDE).toContain(
    'wait target "unlock.seal-pin-entry" event=appear',
  );
  expect(FIRST_VAULT_GATE_GUIDE).not.toContain('focus "unlock.seal-pin"');
  expect(FIRST_VAULT_GATE_GUIDE).toContain('focus "unlock.seal-actions"');
  expect(FIRST_VAULT_GATE_GUIDE).toContain(
    "If it fails or is unavailable, select PIN.",
  );
  expect(FIRST_VAULT_GATE_GUIDE).toContain('focus "unlock.seal-pin-entry"');
  expect(FIRST_VAULT_GATE_GUIDE).toContain(
    'wait state "vault.unlocked" is=true',
  );
  expect(FIRST_VAULT_SHELL_GUIDE).toContain('focus "editor.generate-password"');
  expect(FIRST_VAULT_SHELL_GUIDE).toContain('focus "item.copy-generated"');
});

it("walks the PIN fields only where no passkey road exists", () => {
  registerGuidePredicates();
  const revoke = registerTutorialRealm();
  const known = vi.spyOn(state, "isKnownGuidePredicate").mockReturnValue(true);
  const read = vi.spyOn(state, "readGuidePredicate");
  try {
    const vocabulary = liveVocabulary();

    // The passkey road: the seal step holds until the vault is unlocked and
    // never waits for a PIN entry that road does not draw.
    read.mockReturnValue(true);
    const passkey = firstVaultSignInGuide();
    expect(passkey).toContain("Seal with passkey");
    expect(passkey).toContain("If it fails or is unavailable, select PIN.");
    expect(passkey).toContain('focus "unlock.seal-actions"');
    expect(passkey).toContain('wait state "vault.unlocked" is=true');
    expect(passkey).not.toContain('wait target "unlock.seal-pin-entry"');
    expect(passkey).not.toContain('focus "unlock.seal-pin-entry"');
    expect(passkey).not.toContain('focus "unlock.seal-pin-confirm"');
    expect(
      compileGuide(passkey, vocabulary, AUTHORED_GUIDE_LIMITS),
    ).toMatchObject({ ok: true });

    // The PIN fallback road: the PIN entry is the step's move, then the four
    // fields walk before the vault is unlocked.
    read.mockReturnValue(false);
    const pin = firstVaultSignInGuide();
    expect(pin).toContain('focus "unlock.seal-actions"');
    expect(pin).toContain('wait target "unlock.seal-pin-entry" event=appear');
    expect(pin).toContain('focus "unlock.seal-pin-entry"');
    expect(pin).toContain('focus "unlock.seal-pin-confirm"');
    expect(pin).toContain('focus "unlock.seal-ack"');
    expect(pin).toContain('focus "unlock.seal"');
    expect(pin).toContain('wait state "vault.unlocked" is=true');
    expect(compileGuide(pin, vocabulary, AUTHORED_GUIDE_LIMITS)).toMatchObject({
      ok: true,
    });
  } finally {
    known.mockRestore();
    read.mockRestore();
    revoke();
  }
});
