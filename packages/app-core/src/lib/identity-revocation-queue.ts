/** Retain failed revocations in memory so the user can retry the same session. */
import { lockManager } from "../ports.js";

type Revocation = {
  request: () => Promise<Response>;
  failed: () => Promise<void>;
};

let pending: Promise<void> | null = null;
const failures = new Set<Revocation>();

function schedule(entry: Revocation): void {
  failures.delete(entry);
  pending = (pending ?? Promise.resolve())
    .then(async () => {
      const response = await entry.request();
      if (!response.ok) throw new Error("Identity refused sign-out.");
    })
    .catch(async () => {
      failures.add(entry);
      try {
        await entry.failed();
      } catch {
        // The failed revocation remains available for an explicit retry.
      }
    });
}

export function queueIdentityRevocation(
  request: Revocation["request"],
  failed: Revocation["failed"] = async () => {},
): void {
  schedule({ request, failed });
}

/** Recheck the exact issuer after the browser grants its shared cookie lock. */
export function queueIssuerRevocation(
  issuer: string,
  currentIssuer: () => string,
  request: Revocation["request"],
  failed?: Revocation["failed"],
  requireShared = false,
): void {
  queueIdentityRevocation(() => {
    const guarded = () => {
      if (!issuer || currentIssuer() !== issuer)
        throw new Error("Identity configuration changed during sign-out.");
      return request();
    };
    const locks = lockManager();
    if (!locks && requireShared)
      throw new Error("This browser cannot safely sign out shared sessions.");
    return locks
      ? locks.request("opensesame:identity-cookie-session", guarded)
      : guarded();
  }, failed);
}

export function retryIdentityRevocations(): void {
  for (const entry of [...failures]) schedule(entry);
}

export function identityRevocationPending(): boolean {
  return pending !== null || failures.size > 0;
}

export async function settleIdentityRevocations(): Promise<void> {
  while (pending) {
    const inFlight = pending;
    await inFlight;
    if (pending === inFlight) pending = null;
  }
  if (failures.size) throw new Error("Sign-out did not finish. Try again.");
}
