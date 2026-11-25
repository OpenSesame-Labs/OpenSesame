import {
  FIRST_VAULT_PIN_STEPS,
  FIRST_VAULT_SEAL_INSTRUCTION,
  firstVaultGateGuide,
  firstVaultSealRoadSteps,
} from "./first-vault-guide.js";
import type { GuideGoalDescriptor } from "./goal-types.js";
import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";

/**
 * The tutorials of the screens in front of the shell: the front door, sign-in,
 * unlock, setup, the broker popup and the federation return (ADR 0166).
 *
 * Each is scoped to the one gate whose controls it points at, so the help key
 * a gate draws offers exactly the tours that can be walked there
 * (`tutorialStartsFrom`). A gate cannot navigate, so none of these may
 * `navigate`; a step points at a control that screen draws, or says something.
 * They are the same GuideLang, compiled by the same parser and checked by the
 * same budget as every other authored tour.
 */
export const GATE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "gate.front-door",
    title: "New password",
    routes: ["/unlock/door"],
    // Composed when the tour starts, so the seal road is read live: a
    // passkey browser never waits for the PIN fields (ADR 0180).
    get guide() {
      return firstVaultGateGuide();
    },
  },
  {
    id: "gate.guest",
    title: "Continue as a guest",
    routes: ["/unlock/door"],
    guide: [
      "guide/1",
      'goal "gate.guest"',
      'focus "unlock.guest" "Select Skip to start a temporary guest vault. Its items are deleted when it locks, unless you add a vault key first." side=bottom',
      'success "To keep items between sessions, add a vault key in Settings."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.join",
    title: "Join a session",
    routes: ["/unlock/door"],
    guide: [
      "guide/1",
      'goal "gate.join"',
      'say "Get the session link from its owner. You may also need a separate code."',
      'focus "setup.join" "Select Join a session, then follow the prompts. Exchange codes with the owner if asked." side=bottom',
      'say "Enable Live sessions if prompted. Keep this tab open during the session."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.sign-in",
    title: "Sign in or create a local vault",
    routes: ["/unlock/signin"],
    guide: [
      "guide/1",
      'goal "gate.sign-in"',
      'say "Sign in or create a local vault. You will choose a separate key to protect it."',
      'focus "unlock.signin" "Choose a sign-in provider, or enter your organization\'s address if that option is available." side=top',
      'focus "unlock.local-only" "Select Use without an account for a local vault. Account recovery is unavailable." side=top',
      'success "Protect the vault with a passkey or PIN before adding items."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.unlock",
    title: "Open this device's vault",
    routes: ["/unlock/form"],
    get guide() {
      const creating =
        isKnownGuidePredicate("vault.key-enrolled") &&
        !readGuidePredicate("vault.key-enrolled");
      return [
        "guide/1",
        'goal "gate.unlock"',
        creating
          ? 'say "Protect your new vault with a passkey or a PIN. Your vault is encrypted on this device."'
          : 'say "Use an enrolled key to unlock your vault."',
        creating
          ? 'focus "unlock.methods" "Select PIN, then select Next." side=bottom'
          : 'focus "unlock.methods" "Keep the selected method for this walkthrough." side=bottom',
        ...(creating
          ? FIRST_VAULT_PIN_STEPS
          : [
              'focus "unlock.secret" "Enter the credential for the selected method." side=bottom',
              'focus "unlock.submit" "Select Unlock. If you set up a second step, enter its code when asked." side=top',
            ]),
        'success "You can review vault keys and second steps in Settings → Security."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "gate.unlock.passkey",
    title: "Open this device's vault with a passkey",
    routes: ["/unlock/passkey"],
    // Composed when the tour starts, so the seal road is read live: a
    // passkey browser never waits for the PIN fields (ADR 0180).
    get guide() {
      const creating =
        isKnownGuidePredicate("vault.key-enrolled") &&
        !readGuidePredicate("vault.key-enrolled");
      return [
        "guide/1",
        'goal "gate.unlock.passkey"',
        'say "A passkey uses your device authenticator, such as a fingerprint, face, security key or screen lock."',
        'focus "unlock.passkey" "Select the Passkey tab." side=bottom',
        creating
          ? `focus "unlock.seal-actions" "${FIRST_VAULT_SEAL_INSTRUCTION}" side=right`
          : 'focus "unlock.submit" "Select Unlock with passkey, then approve the prompt." side=top',
        ...(creating ? firstVaultSealRoadSteps() : []),
        'success "If you enrolled a second step, enter its code when asked."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "gate.unlock.account",
    title: "Manage the account on the unlock screen",
    routes: ["/unlock/form", "/unlock/passkey"],
    requires: ["vault.key-enrolled"],
    guide: [
      "guide/1",
      'goal "gate.unlock.account"',
      'say "Your account and your vault key are separate. Signing in does not unlock the vault."',
      'focus "unlock.account" "Open this menu to see the current account, switch vaults, or sign in or out." side=bottom',
      'success "Signing in attaches an account. Use your vault key to unlock the vault."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.choose",
    title: "Choose a setup",
    routes: ["/setup/choose"],
    guide: [
      "guide/1",
      'goal "gate.setup.choose"',
      'say "Choose a setup or select Skip all. You can change features later."',
      'focus "setup.default" "Select Default to use the recommended features." side=bottom',
      'success "Change these choices later in Settings → Features."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup",
    title: "Walk through the setup tabs",
    routes: ["/setup/capabilities"],
    guide: [
      "guide/1",
      'goal "gate.setup"',
      'say "Configure the available features, or skip any tab."',
      'focus "setup.tabs" "Use these tabs to configure features, connections and sign-in." side=bottom',
      'focus "setup.finish" "Select Finish to save your choices, Skip this step to continue, or Skip all to finish setup." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.ways",
    title: "Choose who can sign in",
    routes: ["/setup/identity"],
    guide: [
      "guide/1",
      'goal "gate.setup.ways"',
      'say "Choose which sign-in providers this installation offers."',
      'focus "setup.ways" "Add the providers you want to show on the sign-in screen. You can also use a vault without an account." side=bottom',
      'hint "setup.finish" "Select Finish to save your choices and return to sign-in." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.connectors",
    title: "Import existing connections",
    routes: ["/setup/connectors"],
    guide: [
      "guide/1",
      'goal "gate.setup.connectors"',
      'say "Import existing connection references from a Nango-compatible directory. Tokens are not imported."',
      'focus "setup.connectors" "Enter the directory endpoint and key, then select Sync." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.keep",
    title: "Keep the app on this device",
    routes: ["/setup/capabilities"],
    requires: ["install.offered"],
    guide: [
      "guide/1",
      'goal "gate.setup.keep"',
      'say "Installing OpenSesame lets you open it like an app. Your vault remains stored on this device, so keep a backup."',
      'focus "setup.keep" "Choose whether to install the app. You can continue setup either way." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.broker.consent",
    title: "Approve a static site's sign-in",
    routes: ["/broker/authorize"],
    guide: [
      "guide/1",
      'goal "gate.broker.consent"',
      'say "A static site asked OpenSesame to sign you in. This window is OpenSesame\'s own: the site never sees your vault, only an identity assertion you choose to release."',
      'focus "broker.consent" "Review the requesting site and permissions. Select Allow or Deny, or sign in with a different account." side=bottom',
      'success "You can close this window when it says Done."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.federation.return",
    title: "Finish an identity-provider sign-in",
    routes: ["/federation"],
    guide: [
      "guide/1",
      'goal "gate.federation.return"',
      'say "Wait while sign-in finishes."',
      'focus "federation.return" "If sign-in fails, select Back to sign-in and try again." side=bottom',
      'success "A sign-in that finished takes you back to where you started."',
      "end",
    ].join("\n"),
  },
];
