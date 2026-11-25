/** The parts of the first-vault walkthrough share one title and goal. */
import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";

export const FIRST_VAULT_PIN_STEPS = [
  'focus "unlock.seal-pin-entry" "Enter a PIN for this device." side=top',
  'focus "unlock.seal-pin-confirm" "Confirm your PIN." side=top',
  'focus "unlock.seal-ack" "Confirm that this vault cannot be recovered if you lose the PIN." side=top',
  'focus "unlock.seal" "Select Seal with PIN to create the vault." side=top',
] as const;

export const FIRST_VAULT_SEAL_INSTRUCTION =
  "Accept the recovery notice and select Seal with passkey, if available. If it fails or is unavailable, select PIN.";

/** Every first-vault road is the same walk as far as the seal decision. */
const ROAD_TO_SEAL = [
  'focus "unlock.local-only" "Select Use without an account to keep this vault on this device." side=top',
  'wait target "unlock.local-only" event=activate timeout=60000',
  'wait target "unlock.methods" event=appear timeout=60000',
] as const;

const SEAL_DECISION = `focus "unlock.seal-actions" "${FIRST_VAULT_SEAL_INSTRUCTION}" side=right`;

/**
 * The road from the seal decision on. A passkey seals in one ceremony, so its
 * step holds until the vault is unlocked — waiting there for the PIN fields
 * would stall the walk on the road the instruction leads with (ADR 0180).
 * The PIN road walks its four fields, so it waits for the PIN entry the
 * person is about to open. The road is read where the guide is composed,
 * the way the gate goals read `vault.key-enrolled`: a guide is a fixed
 * program, so the fork is chosen before the first step is drawn, never
 * mid-walk. The passkey gate's creating walk reuses this road verbatim, so
 * a passkey browser is never asked to wait for the PIN entry there either.
 */
export function firstVaultSealRoadSteps(): readonly string[] {
  const passkey =
    isKnownGuidePredicate("vault.seal-passkey") &&
    readGuidePredicate("vault.seal-passkey");
  return passkey
    ? ['wait state "vault.unlocked" is=true timeout=60000']
    : [
        'wait target "unlock.seal-pin-entry" event=appear timeout=60000',
        ...FIRST_VAULT_PIN_STEPS,
        'wait state "vault.unlocked" is=true timeout=60000',
      ];
}

/**
 * The door's first-vault walk: the same road as the sign-in continuation,
 * reached from the front door's own two steps. The seal fork is chosen where
 * the guide is composed, so a passkey road never waits for PIN fields.
 */
export function firstVaultGateGuide(): string {
  return [
    "guide/1",
    'goal "gate.front-door"',
    'focus "unlock.setup" "Select Set up your own to create a vault and password." side=bottom',
    'wait target "unlock.setup" event=activate timeout=60000',
    'focus "setup.default" "Select Default. You can change these features later." side=bottom',
    'wait target "setup.default" event=activate timeout=60000',
    ...ROAD_TO_SEAL,
    SEAL_DECISION,
    ...firstVaultSealRoadSteps(),
    "end",
  ].join("\n");
}

/**
 * The sign-in continuation the gate hands the seal ceremony. It shares the
 * seal road with the door's own walk (`firstVaultGateGuide`).
 */
export function firstVaultSignInGuide(): string {
  return [
    "guide/1",
    'goal "gate.front-door"',
    ...ROAD_TO_SEAL,
    SEAL_DECISION,
    ...firstVaultSealRoadSteps(),
    "end",
  ].join("\n");
}

/**
 * Counted steps of the authored first-vault walks (every presenting beat but
 * the closing one, per `planGuideSteps`). The pages shell's gate handoff
 * keys off these: the sign-in continuation measures six steps on the PIN
 * road and two on the passkey road, and both resume after the door's own
 * two steps. Re-author a walk and these move with it.
 */
export const FIRST_VAULT_DOOR_STEPS = 2;
export const FIRST_VAULT_SIGN_IN_PIN_STEPS = 6;
export const FIRST_VAULT_SIGN_IN_PASSKEY_STEPS = 2;
/** The door's whole walk on the PIN road: the resume fallback when no tour is live to measure. */
export const FIRST_VAULT_GATE_WALK_STEPS = 8;

/**
 * The password walk every first-vault road shares.
 *
 * The Save step waits until the vault HOLDS an item (`vault.has-items`),
 * not for Save to be pressed or the editor to close: `activate` fires
 * before the form runs, so a rejected draft would complete the step, and
 * Cancel or Escape closes the editor without a write. Only a save that
 * actually seals makes the predicate true. The copy control exists only on
 * the saved item, so its `appear` wait follows the save as the way into the
 * copy step. A successful copy completes the walkthrough.
 */
const PASSWORD_STEPS = [
  'navigate "/vault/list"',
  'wait route "/vault/list" timeout=15000',
  'focus "vault.create" "Select New item (+) to add an account." side=bottom',
  'wait target "vault.create" event=activate timeout=60000',
  'focus "item.editor.name" "Name the account. Select Next." side=bottom',
  'focus "editor.password-options" "Open Password options." side=top',
  'wait target "editor.password-options-open" event=appear timeout=60000',
  'focus "editor.pepper-options" "To copy the whole password, turn off Include pepper. Select Next." side=top',
  'focus "editor.generate-password" "Select Generate another password." side=top',
  'wait target "editor.generate-password" event=activate timeout=60000',
  'focus "item.editor.save" "Select Save item to save this account and password." side=top',
  'wait state "vault.has-items" is=true timeout=60000',
  'wait target "item.copy-generated" event=appear timeout=60000',
  'focus "item.copy-generated" "Copy the highlighted part. If pepper is on, add it at its chosen position. For two parts, paste the first before copying the rest." side=bottom',
  'wait target "item.copy-generated" event=activate timeout=60000',
  'success "Copied. Paste it into the password field."',
  "end",
] as const;

export const FIRST_VAULT_SHELL_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  'say "Your vault is ready. Next, create an account and copy its password."',
  ...PASSWORD_STEPS,
].join("\n");

export const FIRST_ITEM_GUIDE = [
  "guide/1",
  'goal "vault.item.first"',
  'say "Create your first account, generate a password, and copy it."',
  ...PASSWORD_STEPS,
].join("\n");

export const FIRST_VAULT_PACK_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  'navigate "/settings/item-types"',
  'wait route "/settings/item-types" timeout=15000',
  'focus "settings.account-pack" "Turn on Account to add password accounts to this vault." side=bottom',
  'wait target "settings.account-ready" event=appear timeout=60000',
  ...PASSWORD_STEPS,
].join("\n");
