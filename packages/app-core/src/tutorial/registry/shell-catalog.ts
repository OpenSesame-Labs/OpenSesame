/**
 * Shell targets — the rail, the statusline and the phone chrome.
 *
 * Split out of `catalog.ts` the way the vault, identity and setup catalogs
 * already are: one file per area, spread back into `GUIDE_TARGETS` in
 * authoring order.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address or any other value a person authored —
 * the whole catalog is handed to a model as page context.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const SHELL_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "nav.menu",
    description: "Open the list of sections on a phone or narrow screen.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.vault",
    description:
      "Open Vault to view accounts, passkeys, cards, secrets and notes.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.settings",
    description:
      "Open Settings to manage preferences, security, features, integrations and vaults.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "shell.lock",
    description:
      "Locks the vault immediately, dropping the in-memory keys. Your unlock method is needed to open it again.",
    role: "action",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.account",
    description:
      "Open the account menu to switch profiles or accounts, attach an account or sign out.",
    role: "action",
    routes: [],
    capabilityId: "identity.signout",
  },
  {
    id: "shell.notifications",
    description:
      "Review notices such as pending links, failed syncs and expiring items.",
    role: "status",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.connectivity",
    description:
      "Open More to review connection status and notices on a phone.",
    role: "status",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "shell.support",
    description:
      "Opens in-product support, where a question about the interface can be asked in plain language.",
    role: "surface",
    routes: [],
    capabilityId: "client.support",
  },
  {
    id: "shell.command-bar",
    description:
      "Typed commands that navigate, search, and copy vault fields. Enter runs the command.",
    role: "surface",
    routes: [],
    capabilityId: "client.command_bar",
  },
];
