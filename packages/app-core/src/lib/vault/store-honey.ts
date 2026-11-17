import { createItem, manualPassword } from "@opensesame/vault-core";
import { HONEY_VAULT_ITEMS } from "../duress/settings/modes/honey-vault.js";
import { mintHoneyToken, registerHoneyToken } from "../honey-tokens.js";
import type { VaultStore } from "./store.js";

const honeyVaultSeededScopes = new Set<string>();

/** Retired-password HoneyVault: convincing credentials, never `hny`-branded. */
export async function seedHoneyVault(
  store: Pick<VaultStore, "getSnapshot" | "purgeItem" | "addItems">,
  ownerScope: string,
): Promise<void> {
  if (honeyVaultSeededScopes.has(ownerScope)) return;
  honeyVaultSeededScopes.add(ownerScope);
  const already = new Set(store.getSnapshot().items.map((item) => item.name));
  const items = HONEY_VAULT_ITEMS.filter((title) => !already.has(title)).map(
    (title) => {
      const { token } = mintHoneyToken();
      return { title, token };
    },
  );
  for (const item of items) {
    try {
      await registerHoneyToken(
        ownerScope,
        `${item.title} (HoneyVault)`,
        item.token,
      );
    } catch {
      // A full/corrupt honey store must not change the unlock presentation.
    }
  }
  try {
    const known = new Set<string>();
    for (const item of store.getSnapshot().items) {
      if (!HONEY_VAULT_ITEMS.some((honeyName) => honeyName === item.name))
        continue;
      if (known.has(item.name)) await store.purgeItem(item.id);
      else known.add(item.name);
    }
    await store.addItems(
      items.map(({ title, token }) => {
        const account = createItem("account", title);
        account.methods = [
          manualPassword(`${account.id}:password`, token, account.createdAt),
        ];
        return account;
      }),
    );
  } catch {
    // The synthetic session still opens; the owner record is what alerts.
  }
}
