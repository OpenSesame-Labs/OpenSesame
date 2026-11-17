/** Schedule durable bound-session revocations under the shared cookie lock. */
import {
  type BoundRevocation,
  forgetBoundRevocation,
  listBoundRevocations,
  readBoundRevocation,
} from "./identity-revocation-journal.js";
import { queueIssuerRevocation } from "./identity-revocation-queue.js";
import { revokeIdentitySession } from "./identity-signout-request.js";

const scheduled = new Set<string>();

/** A second document can retry the same proof, but only while it still exists. */
export function queueBoundRevocation(
  entry: BoundRevocation,
  currentIssuer: () => string,
  failed: () => Promise<void>,
  bearer?: string,
): void {
  if (scheduled.has(entry.key)) return;
  scheduled.add(entry.key);
  queueIssuerRevocation(
    entry.binding.issuerOrigin,
    currentIssuer,
    async () => {
      const stored = readBoundRevocation(entry.key);
      if (!stored) {
        scheduled.delete(entry.key);
        return new Response(null, { status: 204 });
      }
      if (JSON.stringify(stored) !== JSON.stringify(entry))
        throw new Error("Pending sign-out changed.");
      const result = await revokeIdentitySession({
        bound: stored.binding,
        bearer,
        issuer: stored.binding.issuerOrigin,
        orphan: stored.orphan,
        currentIssuer,
      });
      if (result.ok) {
        forgetBoundRevocation(stored.key);
        scheduled.delete(stored.key);
      }
      return result;
    },
    failed,
    entry.orphan,
  );
}

export function restoreBoundRevocations(
  currentIssuer: () => string,
  failed: () => Promise<void>,
): void {
  for (const entry of listBoundRevocations())
    queueBoundRevocation(entry, currentIssuer, failed);
}
