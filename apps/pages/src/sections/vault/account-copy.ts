import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import { concealedValue } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type AccountItem,
  type VaultItem,
  credentialLine,
  handoff,
  produceAccountPassword,
} from "@opensesame/vault-core";

/**
 * Whether the list's "copy secret" has something to give: an account's
 * password counts when the facade produces one, whole or up to its pepper's slot;
 * one with no password gives its API key or token as a header line.
 */
export function canCopySecret(item: VaultItem): boolean {
  if (item.kind !== "account") return Boolean(concealedValue(item));
  return (
    handoff(produceAccountPassword(item)) !== null ||
    credentialLine(item) !== null
  );
}

/**
 * What an account's copy puts out (ADR 0174): the password, or what comes before
 * a pepper's slot; with no password, its API key or token as the header line a
 * request takes. `null` is nothing to copy. The pepper is never asked for.
 */
export function accountSecretToCopy(item: AccountItem): string | null {
  return handoff(produceAccountPassword(item))?.now ?? credentialLine(item);
}

/**
 * What to do once an account's copy lands. Where the copy put out the
 * account's password, that is the moment autofill would have saved the trip,
 * so it is said to the recommender (ADR 0221). A copy that failed says
 * nothing, and neither does one that fell back to an API key or token, which
 * autofill does not fill.
 */
export function accountCopied(item: AccountItem): (result: string) => void {
  const password = handoff(produceAccountPassword(item)) !== null;
  return (result) => {
    if (password && result === "copied") {
      signalRecommendation("password.copied");
    }
  };
}
