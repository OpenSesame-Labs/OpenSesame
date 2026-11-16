/** The parts of the first-vault walkthrough share one title and goal. */
const SIGN_IN_STEPS = [
  'focus "unlock.local-only" "Select Use without an account to keep this vault on this device." side=top',
  'wait target "unlock.local-only" event=activate timeout=60000',
  'focus "unlock.seal" "Choose a passkey or PIN, read the recovery notice, and seal your vault. Then we’ll make a password." side=bottom',
  'wait state "vault.unlocked" is=true timeout=60000',
] as const;

export const FIRST_VAULT_GATE_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  'focus "unlock.setup" "Let’s set up your own vault and make a password. Select Set up your own." side=bottom',
  'wait target "unlock.setup" event=activate timeout=60000',
  'focus "setup.default" "Select Default to add item types and the other default extensions. You can change these later." side=bottom',
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
  'focus "item.editor.name" "Give this account a name, then select Next." side=bottom',
  'focus "editor.password-options" "Open Password options." side=top',
  'wait target "editor.password-options" event=activate timeout=60000',
  'focus "editor.pepper" "Turn off Include pepper for this example so you can copy the whole password." side=top',
  'wait target "editor.pepper" event=activate timeout=60000',
  'focus "editor.generate-password" "Select Generate another password to generate a password for this account." side=top',
  'wait target "editor.generate-password" event=activate timeout=60000',
  'focus "item.editor.save" "Select Save item to keep the account and its password in your vault." side=top',
  'wait target "item.copy-password" event=appear timeout=60000',
  'focus "item.copy-password" "Select Copy password to copy the generated password." side=bottom',
  'wait target "item.copy-password" event=activate timeout=60000',
  'success "Password copied. Your account is saved in your vault."',
  "end",
] as const;

export const FIRST_VAULT_SHELL_GUIDE = [
  "guide/1",
  'goal "gate.front-door"',
  'say "Your vault is ready. Next, you’ll create an account and copy a generated password."',
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
