import type { PasskeyChallengeStore } from "./passkey-challenge-store.js";
import type { ChallengeMeta } from "./webauthn.js";

/**
 * Outstanding challenges kept in memory. Issuing is cheap and unbounded from the
 * caller's side, so the store prunes expired rows and refuses to grow past this.
 */
export const MAX_OUTSTANDING_CHALLENGES = 4096;

export function createMemoryChallengeStore(): PasskeyChallengeStore {
  const map = new Map<string, ChallengeMeta>();
  const byPrincipal = new Map<string | null, Set<string>>();
  let nextExpiry = Number.POSITIVE_INFINITY;

  const remove = (challenge: string): void => {
    const row = map.get(challenge);
    if (!row) return;
    map.delete(challenge);
    const own = byPrincipal.get(row.principalId);
    own?.delete(challenge);
    if (own?.size === 0) byPrincipal.delete(row.principalId);
  };

  return {
    set(challenge, meta) {
      const now = Date.now();
      if (now > nextExpiry) {
        nextExpiry = Number.POSITIVE_INFINITY;
        for (const [key, row] of map) {
          if (now > row.expiresAt) remove(key);
          else nextExpiry = Math.min(nextExpiry, row.expiresAt);
        }
      }
      remove(challenge);
      if (map.size >= MAX_OUTSTANDING_CHALLENGES) {
        // Evict the issuer's own oldest challenge first. Dropping whatever is
        // oldest globally would let one principal, by asking for challenges in
        // bulk, knock another principal's ceremony out of the store mid-login.
        const own = byPrincipal.get(meta.principalId)?.values().next().value;
        const victim = own ?? map.keys().next().value;
        if (victim !== undefined) remove(victim);
      }
      map.set(challenge, meta);
      const own = byPrincipal.get(meta.principalId) ?? new Set<string>();
      own.add(challenge);
      byPrincipal.set(meta.principalId, own);
      nextExpiry = Math.min(nextExpiry, meta.expiresAt);
    },
    consume(challenge) {
      const row = map.get(challenge);
      remove(challenge);
      if (!row) return undefined;
      if (Date.now() > row.expiresAt) return undefined;
      return row;
    },
    peek(challenge) {
      const row = map.get(challenge);
      if (!row) return undefined;
      // Expiry is applied on read rather than only on eviction: a lapsed
      // challenge must look absent to a reader too, or a peek would answer
      // "valid" for something `consume` would refuse a line later.
      if (Date.now() > row.expiresAt) return undefined;
      return row;
    },
  };
}
