/**
 * Tutorials for what a person does with an item that is already in the vault:
 * find it, mark it, edit it, copy from it, set it aside, and see the vaults a
 * device holds (ADR 0163 §6).
 *
 * A tour points at the item's own controls, so it opens the pane of an item
 * (`/vault/item`) and, for the trash, the trash itself (`/vault/trash`); both
 * are places a tour may name without naming an item (`vault-routes.ts`). They
 * need an item to open, so they are offered only where `vault.has-items`
 * holds. The accounts filter and the username and password copy keys exist
 * only while the vault holds an account (`vault.has-account`). A minimal
 * install can seed a secret and nothing else, so those tours stay off there.
 * Trash and delete forever are locked keys (ADR 0156): the tours point
 * at them, and at restore beside them, say what they do, and never press or
 * bind one.
 *
 * Every string is a checked-in literal: nothing here names an item.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import { isTouchGuide } from "./state.js";

const NEEDS_ITEM = ["vault.has-items"] as const;
const NEEDS_ACCOUNT = ["vault.has-items", "vault.has-account"] as const;

export const VAULT_ITEM_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.item.find",
    title: "Find an item",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    get guide() {
      const phone = isTouchGuide();
      return [
        "guide/1",
        'goal "vault.item.find"',
        'say "Use a filter or search to find an item. Neither changes the items in your vault."',
        'navigate "/vault"',
        'wait route "/vault" timeout=15000',
        'focus "vault.filter.favorites" "Choose a filter, such as Favorites, to narrow the item list." side=right',
        phone
          ? 'focus "shell.command-bar" "Tap the command bar and type /? followed by a space and your search terms. The list narrows as you type." side=bottom'
          : 'focus "shell.command-bar" "Press / to start a search. Type your search terms after /?; the list narrows as you type. Enter moves focus to the list, and Esc clears the search." side=bottom',
        'success "Search narrows whichever list is on screen, so pick a filter first to search inside it."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vault.item.accounts",
    title: "Narrow the list to accounts",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ACCOUNT,
    guide: [
      "guide/1",
      'goal "vault.item.accounts"',
      'say "A type is listed among the filters once the vault holds one. Accounts lists only accounts."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.filter.logins" "Accounts lists only accounts." side=right',
      'success "Search still narrows whichever list is on screen, so this filter searches inside accounts."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.favorite",
    title: "Favorite an item",
    routes: [],
    libraryOnly: true,
    requires: NEEDS_ITEM,
    get guide() {
      return [
        "guide/1",
        'goal "vault.item.favorite"',
        'say "Mark items as favorites to find them under the Favorites filter."',
        'navigate "/vault/item"',
        'wait route "/vault/item" timeout=15000',
        isTouchGuide()
          ? 'focus "item.favorite" "Select the star to add or remove this item from Favorites." side=bottom'
          : 'focus "item.favorite" "Select the star to add or remove this item from Favorites. Press . with a row selected to do the same." side=bottom',
        'success "Favorites is one of the filters beside All items."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vault.item.edit",
    title: "Edit an item",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-editable-item"],
    get guide() {
      return [
        "guide/1",
        'goal "vault.item.edit"',
        'say "Open an item in the editor to change its fields. Changes are saved only when you select Save."',
        'navigate "/vault/item"',
        'wait route "/vault/item" timeout=15000',
        isTouchGuide()
          ? 'focus "item.edit" "Select Edit to change this item." side=bottom'
          : 'focus "item.edit" "Select Edit, or press e on a row to open its editor." side=bottom',
        'success "Save keeps your changes. Cancel leaves the item as it was."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vault.item.copy",
    title: "Copy credentials",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-copyable-account"],
    get guide() {
      const phone = isTouchGuide();
      return [
        "guide/1",
        'goal "vault.item.copy"',
        'say "Copy a username or password without revealing it. The app tries to clear copied values when you lock or after the timeout in Settings. Your browser may block clearing or retain clipboard history."',
        'navigate "/vault/item"',
        'wait route "/vault/item" timeout=15000',
        phone
          ? 'focus "item.copy-username" "Select this copy button to copy the username." side=bottom'
          : 'focus "item.copy-username" "Select this copy button, or press u on a row to copy the username." side=bottom',
        phone
          ? 'focus "item.copy-password" "Select this copy button to copy the password. If you use a personal pepper, add it where you use the password." side=bottom'
          : 'focus "item.copy-password" "Select this copy button, or press y on a row to copy its password or secret value. If you use a personal pepper, add it where you use the password." side=bottom',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vault.item.trash",
    title: "Move to Trash",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-items"],
    get guide() {
      const touch = isTouchGuide();
      return [
        "guide/1",
        'goal "vault.item.trash"',
        'say "Move an item to Trash to set it aside. You can restore it later or delete it permanently."',
        'navigate "/vault/item"',
        'wait route "/vault/item" timeout=15000',
        touch
          ? 'focus "item.trash" "Select Move to trash, then select it again to confirm." side=bottom'
          : 'focus "item.trash" "Select Move to trash, then select it again to confirm. Press x in the list to trash the row under the cursor." side=bottom',
        'success "You can restore the item or delete it permanently from Trash."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vault.item.restore",
    title: "Manage Trash",
    routes: [],
    libraryOnly: true,
    requires: ["vault.has-trash"],
    get guide() {
      const touch = isTouchGuide();
      return [
        "guide/1",
        'goal "vault.item.restore"',
        'say "Items in Trash can be restored or permanently deleted."',
        'navigate "/vault/trash"',
        'wait route "/vault/trash" timeout=15000',
        touch
          ? 'focus "trash.restore" "Select Restore to return the item to your vault." side=bottom'
          : 'focus "trash.restore" "Select Restore to return the item to your vault, or press r on a selected row." side=bottom',
        touch
          ? 'focus "trash.purge" "Select Delete permanently twice to erase the selected item for good." side=bottom'
          : 'focus "trash.purge" "Delete permanently erases the selected item for good. Select it twice to confirm, or press X twice on a selected row." side=bottom',
        'success "Items in Trash stay sealed until you delete them."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "vaults.manage",
    title: "See the vaults on this device",
    routes: [],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "vaults.manage"',
      'say "This device can hold several vaults. Settings → Vaults lists them and lets you create or delete a project vault."',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "vaults.list" "Select a vault to switch to it. You can delete a project vault after confirming, except the vault that is open." side=top',
      'success "Select the plus button to create a new vault."',
      "end",
    ].join("\n"),
  },
];
