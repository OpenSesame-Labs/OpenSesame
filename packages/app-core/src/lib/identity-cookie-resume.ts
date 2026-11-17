import { isLocalOnlyGuest } from "./guest-session-context.js";
import { readCookieSession } from "./identity-cookie-session.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";

type ResumeHost = {
  epoch: () => number;
  origin: () => string;
  current: () => IdentitySession | null;
  publish: (session: IdentitySession) => void;
};

/** Restore only while the original tab, service and guest boundary remain current. */
export async function resumeIdentityCookie(
  check: () => void,
  host: ResumeHost,
): Promise<IdentitySession | null> {
  if (isLocalOnlyGuest())
    throw new Error(
      "This vault is local only. Sign out and start a new guest session to connect services.",
    );
  check();
  const existing = host.current();
  if (existing) return existing;
  const epoch = host.epoch();
  const origin = host.origin();
  const current = () => {
    check();
    return (
      !isLocalOnlyGuest() && host.epoch() === epoch && host.origin() === origin
    );
  };
  const restored = await readCookieSession(origin, current);
  if (!current())
    throw new IdentityError(
      "The session ended while it was being restored.",
      409,
    );
  const newer = host.current();
  if (newer) return newer;
  if (!restored) return null;
  host.publish(restored);
  return restored;
}
