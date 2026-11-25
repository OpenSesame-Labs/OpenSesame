import { ambientAuthSeams, isAmbientIntent } from "../lib/ambient-auth-seam.js";
import { storeAuthOutcome } from "../lib/auth-outcome.js";
import {
  adoptBrokeredSession,
  completeReturn,
  displayName,
} from "../lib/federation.js";
import { assertSafeReturnTo } from "../lib/federation-callback.js";
import { federationSessionGeneration } from "../lib/federation-native-session.js";
import {
  adoptFederatedIdentity,
  openVaultAfterSignIn,
} from "../lib/guest-auth.js";
import { ensureIdentitySession } from "../lib/identity.js";
import { joinOrgTenant } from "../lib/orgs.js";
/**
 * View-model logic for `FederationReturn` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { pageOrigin } from "../ports.js";

export type ReturnOutcome = { returnTo?: string };

type CompletedReturn = NonNullable<Awaited<ReturnType<typeof completeReturn>>>;

async function applyIdentityReturn(
  result: Exclude<CompletedReturn, { magicLink: unknown }>,
  generation: ReturnType<typeof federationSessionGeneration>,
): Promise<void> {
  if (result.orgSlug && result.orgMethod) {
    await ensureIdentitySession();
    await joinOrgTenant(
      result.orgSlug,
      result.orgMethod,
      result.identity.idToken,
    );
    storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
    return;
  }
  if (result.accessToken) {
    // The Identity API bound this broker token to its principal. The adjacent
    // id_token is pairwise for this origin and must never be linked to whichever
    // session this tab happens to hold (T23).
    await adoptBrokeredSession(result.accessToken, generation);
    const inApp =
      result.returnTo === undefined && (await openVaultAfterSignIn());
    if (!inApp) {
      storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
    }
    return;
  }
  if (!result.identity?.idToken) return;
  // Unlike a brokered token, this explicit identity return is the link path.
  const adopted = await adoptFederatedIdentity(result.identity.idToken);
  const inApp = await openVaultAfterSignIn();
  if (!inApp && adopted.kind !== "pending_link") {
    storeAuthOutcome(
      adopted.kind === "linked" || adopted.kind === "local"
        ? { kind: "linked", who: displayName(result.identity) }
        : {
            kind: "link_failed",
            detail: adopted.reason,
            who: displayName(result.identity),
          },
    );
  }
}

export async function processReturn(): Promise<ReturnOutcome> {
  const generation = federationSessionGeneration();
  const result = await completeReturn();
  if (!result) return {};
  if ("magicLink" in result) {
    // The email-link exchange already adopted the member session. Land in the
    // app like any other finished sign-in; a locked vault gets the banner.
    if (!(await openVaultAfterSignIn()))
      storeAuthOutcome({ kind: "authenticated" });
    return {};
  }
  if (isAmbientIntent(result.intent)) {
    return ambientAuthSeams.applyAmbientReturn({
      ...result,
      intent: result.intent,
    });
  }
  /*
   * Keep the mutually exclusive identity outcomes in one helper. Besides
   * making the ceremony readable, this preserves the important ordering:
   * adoption completes before any success notice is stored.
   */
  await applyIdentityReturn(result, generation);
  const returnTo = assertSafeReturnTo(result.returnTo, pageOrigin(), "/");
  return returnTo !== undefined ? { returnTo } : {};
}

export let inFlightReturn: Promise<ReturnOutcome> | null = null;

/** Test hook: drop a ceremony a previous test left unsettled. */
export function resetFederationReturnCeremony(): void {
  inFlightReturn = null;
}

/** The one shared ceremony; cleared once settled so a later sign-in reruns. */
export function runReturn(): Promise<ReturnOutcome> {
  if (!inFlightReturn) {
    inFlightReturn = processReturn().finally(() => {
      inFlightReturn = null;
    });
  }
  return inFlightReturn;
}
