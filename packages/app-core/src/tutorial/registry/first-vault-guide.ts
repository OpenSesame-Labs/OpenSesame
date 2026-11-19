/** The parts of the first-vault walkthrough share one title and goal. */
export const FIRST_VAULT_PIN_STEPS = [
  'focus "unlock.seal-pin-entry" "Enter a PIN for this device." side=top',
  'focus "unlock.seal-pin-confirm" "Enter the PIN again to confirm it." side=top',
  'focus "unlock.seal-ack" "Confirm that this vault cannot be recovered if you lose the PIN." side=top',
  'focus "unlock.seal" "Select Seal with PIN to create the vault." side=top',
] as const;

export const FIRST_VAULT_SEAL_INSTRUCTION =
  "Accept the recovery notice and select Seal with passkey, if available. If it fails or is unavailable, use PIN and select Next.";

const SIGN_IN_STEPS = [
  'focus "unlock.local-only" "Select Use without an account to keep this vault on this device." side=top',
  'wait target "unlock.local-only" event=activate timeout=60000',
  'wait target "unlock.methods" event=appear timeout=60000',
  `focus "unlock.seal-actions" "${FIRST_VAULT_SEAL_INSTRUCTION}" side=bottom`,
  ...FIRST_VAULT_PIN_STEPS,
  'wait state "vault.unlocked" is=true timeout=60000',
] as const;

export const FIRST_VAULT_GATE_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  'focus "unlock.setup" "Select Set up your own to create a vault and password." side=bottom',
  'wait target "unlock.setup" event=activate timeout=60000',
  'focus "setup.default" "Select Default. You can change these features later." side=bottom',
  'wait target "setup.default" event=activate timeout=60000',
  ...SIGN_IN_STEPS,
  "end",
].join("\n");

export const FIRST_VAULT_SIGNIN_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  ...SIGN_IN_STEPS,
  "end",
].join("\n");

const PASSWORD_STEPS = [
  'navigate "/vault/list"',
  'wait route "/vault/list" timeout=15000',
  'focus "vault.create" "Select New item (+) to add an account." side=bottom',
  'wait target "vault.create" event=activate timeout=60000',
  'focus "item.editor.name" "Name the account. Select Next." side=bottom',
  'focus "editor.password-options" "Open Password options." side=top',
  'wait target "editor.pepper" event=appear timeout=60000',
  'focus "editor.pepper-options" "Turn off Include pepper to copy the whole password. Keeping it on adds protection with your own secret; add it when using the password. Select Next." side=top',
  'focus "editor.generate-password" "Select Generate another password." side=top',
  'wait target "editor.generate-password" event=activate timeout=60000',
  'focus "item.editor.save" "Select Save item to save this account and password." side=top',
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
