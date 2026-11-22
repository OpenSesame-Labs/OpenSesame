import {
  type AccountItem,
  type Folder,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { typePassword } from "../account.test-support.js";
import { planManifestMerge, vaultItemToEntry } from "./store-sync.js";

function account(name: string, password: string): AccountItem {
  const item = createItem("account", name);
  const method = passwordMethod(item);
  if (method) typePassword(method, password);
  return item;
}

describe("store sync manifest formal replay", () => {
  const folders: Folder[] = [
    { id: "f1", name: "Email", createdAt: new Date().toISOString() },
  ];

  it("does not update a trashed item in place when the manifest re-imports its path", () => {
    const trashed = account("github.com", "old");
    trashed.deletedAt = new Date().toISOString();
    const entry = vaultItemToEntry(trashed, folders);
    const plan = planManifestMerge([entry], [trashed], folders);
    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toHaveLength(1);
  });
});
