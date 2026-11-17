import { FIRST_VAULT_GATE_GUIDE } from "./first-vault-guide.js";
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
    title: "Set up a vault and create a password",
    routes: ["/unlock/door"],
    guide: FIRST_VAULT_GATE_GUIDE,
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
      'say "To join a live session, you need a link from its owner. An invitation may also include a code sent separately."',
      'focus "setup.join" "Select Join a session. Follow the prompts to exchange request and reply codes with the owner, unless the link handles that exchange for you." side=bottom',
      'say "The first time, review and enable Live sessions when prompted. The shared session stays in this tab until it ends."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.sign-in",
    title: "Sign in, or seal this device without an account",
    routes: ["/unlock/signin"],
    guide: [
      "guide/1",
      'goal "gate.sign-in"',
      'say "You can sign in with an account or use a vault on this device without one. Either way, you will choose a separate key to protect the vault."',
      'focus "unlock.signin" "Choose a sign-in provider, or enter your organization\'s address if that option is available." side=top',
      'focus "unlock.local-only" "Select Use without an account to create a local vault. You will choose a passkey or PIN next; there is no account recovery or account sync." side=top',
      'success "Either way the vault is sealed on this device before anything is stored in it."',
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
          : 'say "Unlock your vault with a key you enrolled on this device. The vault is decrypted in this browser."',
        'focus "unlock.methods" "Choose the method you want to use." side=bottom',
        creating
          ? 'focus "unlock.secret" "Enter a PIN, then enter it again in Confirm PIN. Read and accept the recovery notice below." side=bottom'
          : 'focus "unlock.secret" "Enter the information for the method you selected." side=bottom',
        creating
          ? 'focus "unlock.submit" "Select Seal with PIN to create the vault." side=top'
          : 'focus "unlock.submit" "Select Unlock. If you set up a second step, enter its code when asked." side=top',
        'success "You can review vault keys and second steps in Settings → Security."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "gate.unlock.passkey",
    title: "Open this device's vault with a passkey",
    routes: ["/unlock/passkey"],
    guide: [
      "guide/1",
      'goal "gate.unlock.passkey"',
      'say "A passkey uses your device authenticator, such as a fingerprint, face, security key or screen lock."',
      'focus "unlock.passkey" "Select the Passkey tab." side=bottom',
      'focus "unlock.submit" "If you are setting up a vault, read and accept the recovery notice. Then select this button and approve the passkey prompt." side=top',
      'success "If you enrolled a second step, enter its code when asked."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.unlock.account",
    title: "Who is signed in on the unlock screen",
    routes: ["/unlock/form", "/unlock/passkey"],
    requires: ["vault.key-enrolled"],
    guide: [
      "guide/1",
      'goal "gate.unlock.account"',
      'say "Your account and your vault key are separate. Signing in does not unlock the vault."',
      'focus "unlock.account" "Open this menu to see the current account, switch vaults, or sign in or out." side=bottom',
      'success "Sign in here attaches an account. The key to the vault is still the one you enrolled."',
      "end",
    ].join("\n"),
  },
  {
    id: "gate.setup.choose",
    title: "Choose how to set this device up",
    routes: ["/setup/choose"],
    guide: [
      "guide/1",
      'goal "gate.setup.choose"',
      'say "Setup is optional. Nothing has to be answered before you can use the app, and Skip all leaves everything as it is."',
      'focus "setup.configurations" "Default is the one to take if you are not sure: passwords, passkeys, cards and notes, plus sign-in, connections and access. Minimal holds plain secrets and files only, with no password type until you turn one on. Full turns everything on, and Custom lets you pick individual capabilities." side=bottom',
      'success "Whatever you choose here can be changed later in Settings, then Features."',
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
      'say "Setup has optional tabs for configuring this installation. You can skip any tab."',
      'focus "setup.tabs" "Use these tabs to configure features, connectors and sign-in options that are available on this installation." side=bottom',
      'focus "setup.finish" "Select Finish to save your choices and return to sign-in. Skip this step moves to the next tab; Skip all leaves the remaining tabs unchanged." side=top',
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
    title: "Bring connectors across by reference",
    routes: ["/setup/connectors"],
    guide: [
      "guide/1",
      'goal "gate.setup.connectors"',
      'say "You can import references to connections already authorized in a Nango-compatible directory. Their tokens are not imported."',
      'focus "setup.connectors" "Enter the directory endpoint and key, then select Sync. The key is encrypted in your vault, or held in memory until the vault is created." side=bottom',
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
      'focus "broker.consent" "The card says which site is asking and for which scopes. If you are not signed in yet it asks you to sign in first. Allow releases the assertion to that site only, Deny sends it a refusal, and Use a different account signs this one out first." side=bottom',
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
      'say "You are back from an identity provider. This screen finishes that sign-in and sends you on. It takes a moment and needs nothing from you."',
      'focus "federation.return" "While it works it says Finishing sign-in. If the provider\'s answer cannot be used it says so here, with Back to sign-in to start again." side=bottom',
      'success "A sign-in that finished takes you back to where you started."',
      "end",
    ].join("\n"),
  },
];
