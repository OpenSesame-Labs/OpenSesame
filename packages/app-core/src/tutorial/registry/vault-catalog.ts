/**
 * Vault targets — the list, its filters and the ways items get in.
 *
 * Split out of `catalog.ts` the way the identity and setup catalogs already
 * are: one file per area, spread back into `GUIDE_TARGETS` in authoring order.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name or any other value a person authored — the whole catalog
 * is handed to a model as page context.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const VAULT_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.account-pack",
    description: "The switch that installs the Account item type.",
    role: "action",
    routes: ["/settings/item-types"],
    capabilityId: null,
  },
  {
    id: "settings.account-ready",
    description: "The Account item type after it has finished installing.",
    role: "status",
    routes: ["/settings/item-types"],
    capabilityId: null,
  },
  {
    id: "editor.password-options",
    description: "Opens the password generator options.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "editor.password-options-open",
    description: "The password options button while its panel is open.",
    role: "status",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
    authoredOnly: true,
  },
  {
    id: "editor.pepper-options",
    description:
      "Choose whether to include a personal pepper and where it goes.",
    role: "surface",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "editor.generate-password",
    description: "Generates another password in the editor.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.list",
    description:
      "View vault items grouped by folder and narrowed by the selected filter.",
    role: "surface",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.create",
    description:
      "Create an item of the selected filter’s type, or an account by default. Save it in the editor.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.import",
    description:
      "Choose a password-manager export, .env file or encrypted backup, then review it before importing.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.import",
  },
  {
    id: "vault.filter",
    description: "Open the filter menu on a narrow screen.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.favorites",
    description: "Show items marked as favorites.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.logins",
    description:
      "Show accounts. This filter appears when the vault has an account.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.health.summary",
    description: "Review counts of checked, weak, reused and aging passwords.",
    role: "status",
    routes: ["/vault/health"],
    capabilityId: null,
  },
  {
    id: "vault.health.findings",
    description: "Review password findings and open affected items.",
    role: "surface",
    routes: ["/vault/health"],
    capabilityId: null,
  },
  {
    id: "item.editor.name",
    description: "Name the vault item.",
    role: "surface",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.editor.save",
    description: "Save the item to the encrypted vault.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.favorite",
    description: "Add or remove the item from Favorites.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.edit",
    description:
      "Open the item editor. Changes are saved when you select Save.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.trash",
    description:
      "Move the item to Trash, where it can be restored or permanently deleted.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.copy-username",
    description:
      "Copy the account username to the clipboard. Available when the account has a username.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "item.copy-password",
    description:
      "Copy the password without revealing it. The app tries to clear the clipboard on lock and after the configured delay. Your browser may block clearing or retain clipboard history. Available when the account has a password.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "item.copy-generated",
    description:
      "Copy the generated password parts, including the part after a pepper when present.",
    role: "action",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
    authoredOnly: true,
  },
  {
    id: "trash.restore",
    description: "Restore the selected item from Trash.",
    role: "action",
    routes: ["/vault/trash"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "trash.purge",
    description: "Permanently delete the selected item after confirmation.",
    role: "action",
    routes: ["/vault/trash"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "item.credentials.references",
    description:
      "Download an environment template with references to the item’s secret fields.",
    role: "surface",
    routes: ["/vault/item"],
    capabilityId: "vault.items.reveal",
  },
  {
    id: "item.credentials.compare",
    description:
      "Compare a typed password with the saved password without revealing either value.",
    role: "surface",
    routes: ["/vault/item"],
    capabilityId: "vault.workflow.compare_private",
  },
];
