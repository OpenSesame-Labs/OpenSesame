/**
 * Where a tour's `navigate` goes when the route names a place, not a path.
 *
 * `/vault/item` is the pane of an item and `/vault/trash` the list of what was
 * trashed; neither is an address a program could spell, because an item's
 * address holds its id and the trash is a filter. The tour names the place and
 * this resolves it, reading the vault only for the id of the first item that is
 * not in the trash — never a name, a field or a value.
 */

import {
  type AccountItem,
  type VaultItem,
  producePassword,
  sortItems,
} from "@opensesame/vault-core";
import { vaultStore } from "../../lib/vault/store.js";
import { shareText } from "../../sections/vault-share-text.js";
import { type GuideRouteId, guideRouteForLocation } from "./routes.js";

export const VAULT_LIST_ROUTE = "/vault/list";
export const VAULT_ITEM_ROUTE = "/vault/item";
export const VAULT_TRASH_ROUTE = "/vault/trash";

function firstAccountList(
  route: GuideRouteId,
  here: { readonly pathname: string; readonly search: string },
  goal?: string | null,
): boolean {
  if (route !== VAULT_LIST_ROUTE) return false;
  if (goal !== "gate.front-door" && goal !== "vault.item.first") return false;
  const params = new URLSearchParams(here.search);
  return !(
    guideRouteForLocation(here.pathname, here.search) === route &&
    params.get("f") === "account" &&
    !params.has("folder")
  );
}

function eligibleForGoal(goal?: string | null) {
  if (goal === "vault.item.copy") return isCopyableAccount;
  if (goal === "vault.item.edit") return isEditableTutorialItem;
  if (goal === "vault.item.share") return isShareableTutorialItem;
  return null;
}

/**
 * The address to go to for `route`, or `null` when nothing should move: the
 * person is already in that place, or there is no item to open. `here` is the
 * router's own location, so a deployment under a base path reads the same.
 */
export function guideNavigationPath(
  route: GuideRouteId,
  here: { readonly pathname: string; readonly search: string },
  goal?: string | null,
): string | null {
  if (
    route !== VAULT_LIST_ROUTE &&
    route !== VAULT_ITEM_ROUTE &&
    route !== VAULT_TRASH_ROUTE
  )
    return route;
  // Both password walkthroughs need New item to open an account editor,
  // even when the person started in a list filtered to another item type.
  if (firstAccountList(route, here, goal)) return "/vault?f=account";
  const eligible = eligibleForGoal(goal);
  if (route === VAULT_ITEM_ROUTE && eligible) {
    const items = sortItems(vaultStore.getSnapshot().items.filter(eligible));
    if (items.some((item) => here.pathname.endsWith(`/vault/${item.id}`)))
      return null;
    return items[0] ? `/vault/${items[0].id}` : null;
  }
  if (guideRouteForLocation(here.pathname, here.search) === route) return null;
  if (route === VAULT_LIST_ROUTE) return "/vault?f=all";
  if (route === VAULT_TRASH_ROUTE) return "/vault?f=trash";
  const [first] = sortItems(
    vaultStore.getSnapshot().items.filter((item) => item.deletedAt === null),
  );
  return first ? `/vault/${first.id}` : null;
}

export function isEditableTutorialItem(item: VaultItem): boolean {
  return item.deletedAt === null && item.kind !== "drop";
}

export function isShareableTutorialItem(item: VaultItem): boolean {
  return isEditableTutorialItem(item) && shareText(item) !== null;
}

/** Whether an account has both copy controls taught by the copy tutorial. */
export function isCopyableAccount(item: VaultItem): item is AccountItem {
  if (item.deletedAt !== null || item.kind !== "account" || !item.username)
    return false;
  const password = item.methods.find((method) => method.type === "password");
  if (password?.type !== "password") return false;
  const result = producePassword(password);
  return (
    result.status === "ok" ||
    (result.status === "slotted" && result.head !== "" && result.tail === "")
  );
}
