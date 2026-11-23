/**
 * The remote half of ending an Identity session, split out of identity.ts.
 *
 * A cookie revoke is journalled (`identity-revocation-journal.ts`) before the
 * session is forgotten and forgotten only once the service confirms it, so a
 * reload or another tab finishes it instead of resuming the cookie. Sign-in
 * roads call `requireNoOwedRevocation` first: while a revoke is owed they
 * retry it, and refuse rather than adopt or mint beside a live old cookie.
 */
import { resolveIdentityBase } from "./device-identity.js";
import {
  RevocationJournalError,
  forgetRevocation,
  revocationPendingFor,
  stageRevocation,
  sweepRevocations,
} from "./identity-revocation-journal.js";
import { IdentityError } from "./identity-session-types.js";
import {
  flushBearerRevokes,
  hasPendingBearerRevokes,
  rememberBearerRevoke,
  requireIssuer,
  revokeIdentityRequest,
  settleRevokes,
} from "./identity-token-proof.js";

export const SIGN_OUT_UNFINISHED =
  "Sign-out did not finish. Check your connection, then try again.";

export type SignOutWork = {
  base: string;
  bearer: string | undefined;
  /** A fresh guest's bearer travels alone; its cookie plane is not ours. */
  isolated: boolean;
  /** This sign-out's own journal entry, which may carry the bearer here. */
  journal: string | undefined;
  setOrphan(next: boolean | null, base: string): void;
  recheckOrphan(): Promise<void>;
  cookieRevoked(): void;
  settled(): void;
};

/** Journal the owed cookie revoke; `failure` is set when it stayed in memory. */
export type JournalledSignOut = {
  key: string | undefined;
  failure: RevocationJournalError | undefined;
};

export function journalSignOut(base: string): JournalledSignOut {
  if (!base) return { key: undefined, failure: undefined };
  const { key, saved } = stageRevocation(base);
  return {
    key,
    failure: saved
      ? undefined
      : new RevocationJournalError("Sign-out could not be saved."),
  };
}

async function sweep(
  base: string,
  journal?: string,
  bearer?: string,
): Promise<boolean> {
  let bearerSent = false;
  const clear = await sweepRevocations(base, (key) => {
    requireIssuer(base);
    bearerSent ||= Boolean(bearer) && key === journal;
    return revokeIdentityRequest(
      key === journal ? bearer : undefined,
      "include",
      base,
    );
  });
  // Another tab may have finished this entry's cookie revoke first; a pasted
  // bearer names its own session, so it is still sent, without the cookie.
  if (!clear || !bearer || bearerSent) return clear;
  return (await revokeIdentityRequest(bearer, "omit", base)).ok;
}

/** The queued remote work of one sign-out. */
export async function finishSignOut(work: SignOutWork): Promise<void> {
  const { base, bearer, isolated, journal } = work;
  try {
    if (!(await flushBearerRevokes(base))) {
      if (bearer) rememberBearerRevoke(bearer, base);
      work.setOrphan(true, base);
      return;
    }
    requireIssuer(base);
    if (!isolated) {
      const clear = journal
        ? await sweep(base, journal, bearer)
        : (await revokeIdentityRequest(bearer, "include", base)).ok &&
          (await sweep(base));
      requireIssuer(base);
      if (!clear) {
        if (bearer) rememberBearerRevoke(bearer, base);
        await work.recheckOrphan();
        return;
      }
      work.cookieRevoked();
    }
    work.settled();
  } catch {
    // On network failure, assume the cookie may still authenticate.
    if (bearer) rememberBearerRevoke(bearer, base);
    if (resolveIdentityBase() !== base) work.setOrphan(true, base);
    else await work.recheckOrphan();
  }
}

/** While a sign-out is owed, the old cookie must not answer for anyone. */
export function refuseCookieWhileOwed(base: string): void {
  if (revocationPendingFor(base))
    throw new IdentityError("Finish signing out before signing in again.", 409);
}

/** Retry an owed revoke for `base`, refusing sign-in while it stays owed. */
export async function requireNoOwedRevocation(base: string): Promise<void> {
  if (!revocationPendingFor(base)) return;
  await settleRevokes();
  const clear = await sweep(base);
  requireIssuer(base);
  if (!clear) throw new IdentityError(SIGN_OUT_UNFINISHED, 503);
}

/**
 * Wait for every queued revoke, then for the journal. Rejects while any
 * revoke for the configured service is still owed, so a caller can tell the
 * person sign-out is incomplete instead of implying it finished.
 */
export async function settleSignOut(): Promise<void> {
  await settleRevokes();
  const base = resolveIdentityBase();
  if (!base) return;
  if (hasPendingBearerRevokes(base) && !(await flushBearerRevokes(base)))
    throw new IdentityError(SIGN_OUT_UNFINISHED, 503);
  await requireNoOwedRevocation(base);
}

export { forgetRevocation, revocationPendingFor };
