/** The parts of the first-vault walkthrough share one title and goal. */
const SIGN_IN_STEPS = [
  'focus "unlock.local-only" "Select Use without an account to keep this vault on this device." side=top',
  'wait target "unlock.local-only" event=activate timeout=60000',
  'focus "unlock.seal-pin" "Select PIN to protect this vault." side=bottom',
  'wait target "unlock.seal-pin-entry" event=appear timeout=60000',
  'focus "unlock.seal-pin-entry" "Enter an 8–12 character PIN." side=bottom',
  'focus "unlock.seal-pin-confirm" "Confirm PIN. Select Next." side=bottom',
  'focus "unlock.seal-ack" "Read the notice, select the checkbox, then select Next." side=bottom',
  'focus "unlock.seal" "Select Seal with PIN." side=bottom',
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
  'focus "editor.pepper" "Turn off Include pepper to copy the complete password." side=top',
  'wait target "editor.pepper-enabled" event=disappear timeout=60000',
  'focus "editor.generate-password" "Select Generate another password." side=top',
  'wait target "editor.generate-password" event=activate timeout=60000',
  'focus "item.editor.save" "Select Save item to save this account and password." side=top',
  'wait target "item.copy-password" event=appear timeout=60000',
  'focus "item.copy-password" "Select Copy password." side=bottom',
  'wait target "item.copy-password" event=activate timeout=60000',
  'success "Password copied. Your account is saved in your vault."',
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
