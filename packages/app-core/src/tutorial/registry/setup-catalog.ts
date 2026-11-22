import type { GuideTargetDescriptor } from "./targets.js";

/**
 * The gates: the front door and unlock screen, the setup ceremony, and the
 * broker and federation returns. Split from the main catalog so the boot path
 * has one file to read (ADR 0115).
 */
/** The setup ceremony's tabs that have a tour; the tabs' own frame is on all of them. */
const CEREMONY = [
  "/setup/capabilities",
  "/setup/identity",
  "/setup/connectors",
];

export const SETUP_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "setup.default",
    description: "Selects the default setup and its optional extensions.",
    role: "action",
    routes: ["/setup/choose"],
    capabilityId: null,
  },
  {
    id: "unlock.seal",
    description: "Seals a new vault with the selected unlock method.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.seal-pin",
    description: "Chooses PIN when sealing a new vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.seal-pin-entry",
    description: "The device PIN field for a new vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.seal-pin-confirm",
    description: "The PIN confirmation field for a new vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.seal-ack",
    description: "Acknowledges the new vault's recovery notice.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.seal-actions",
    description: "The recovery notice and action that seal a new vault.",
    role: "surface",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.submit",
    description:
      "Unlock the vault with the selected method, or finish creating a new vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.secret",
    description:
      "Enter the PIN, password or recovery credential for the selected method.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.passkey",
    description: "Choose a passkey to unlock this vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.methods",
    description:
      "Choose an enrolled unlock method, or a passkey or PIN when creating a vault.",
    role: "navigation",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.guest",
    description:
      "Select Skip on the welcome screen or Skip to the guest vault on the unlock screen. A guest vault is sealed on this device, apart from every other vault, which it never reads. A new guest vault holds no key, so locking erases its items; protect it with a PIN or authenticator code and the vault survives lock, reopening with that key.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.local-only",
    description:
      "Create a local vault without an account and protect it with a passkey or PIN. Account recovery is unavailable.",
    role: "action",
    routes: ["/unlock/signin"],
    capabilityId: null,
  },
  {
    id: "unlock.account",
    description: "Open the account menu to switch vaults, sign in or sign out.",
    role: "status",
    routes: ["/unlock"],
    capabilityId: "identity.signout",
  },
  {
    id: "unlock.signin",
    description:
      "Choose a configured identity provider or enter an issuer to sign in.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "identity.login",
  },
  {
    id: "vaults.list",
    description: "Select a vault on this device to switch to it.",
    role: "surface",
    routes: ["/unlock", "/settings/vaults"],
    capabilityId: "vaults.switch",
  },
  {
    id: "prompt.tomb",
    description:
      "Select the vault name to switch between vaults on this device.",
    role: "action",
    routes: [],
    capabilityId: "vaults.switch",
  },
  {
    id: "unlock.setup",
    description:
      "Open setup to configure optional features and sign-in providers.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.join",
    description:
      "Join a live session using a shared link or by exchanging request and reply codes. An invitation may also require a code.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.tabs",
    description:
      "Move between setup sections. Available sections depend on the features enabled.",
    role: "navigation",
    routes: CEREMONY,
    capabilityId: null,
  },
  {
    id: "setup.ways",
    description: "Choose the sign-in providers allowed for this installation.",
    role: "surface",
    routes: ["/setup/identity"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.connectors",
    description:
      "Enter a compatible connector directory endpoint and key, then sync its connections by reference.",
    role: "surface",
    routes: ["/setup/connectors"],
    capabilityId: "connectors.directory.sync",
  },
  {
    id: "setup.keep",
    description:
      "Choose whether to install OpenSesame as an app on this device.",
    role: "action",
    routes: CEREMONY,
    capabilityId: "app.install",
  },
  {
    id: "setup.finish",
    description: "Finish setup and continue to sign-in.",
    role: "action",
    routes: CEREMONY,
    capabilityId: "setup.first_run",
  },
  {
    id: "broker.consent",
    description:
      "Review and approve the identity assertion requested by the site, or see why authorization cannot proceed.",
    role: "ceremony",
    routes: ["/broker/authorize"],
    capabilityId: "identity.login",
  },
  {
    id: "federation.return",
    description:
      "Shows sign-in progress or an error after returning from an identity provider.",
    role: "ceremony",
    routes: ["/federation"],
    capabilityId: "identity.login",
  },
];
