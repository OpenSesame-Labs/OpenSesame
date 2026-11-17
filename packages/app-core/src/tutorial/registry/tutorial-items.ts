import {
  type AccountItem,
  type VaultItem,
  producePassword,
} from "@opensesame/vault-core";
import { shareText } from "../../sections/vault-share-text.js";

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
