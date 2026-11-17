/** Finish revoking a provider return before reporting guest sign-out complete. */
import { maybeSessionStore, sessionStore } from "../ports.js";
import { storeAuthOutcome } from "./auth-outcome.js";
import { federationCurrentSessionSeam } from "./federation-current-session.js";
import { federationSessionGeneration } from "./federation-native-session.js";
import {
  type GuestContinuation,
  forgetGuestContinuation,
  parseGuestContinuation,
} from "./guest-continuation.js";
import {
  claimRevokedGuestBarrier,
  clearGuestSignOutBarrier,
  guestSignOutBarrierActive,
  guestSignOutCleanupIncomplete,
  markGuestSignOutBarrier,
} from "./guest-return-barrier.js";
import {
  assertGuestReturnEpoch,
  captureGuestReturnEpoch,
} from "./guest-return-epoch.js";
import { revokeStoredGuestReturn } from "./guest-return-record.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import {
  currentSession,
  identitySessionEpoch,
  identitySessionRevision,
  settleRevokes,
} from "./identity.js";
import { listNotices } from "./notices.js";
import { announceGuestSignOut } from "./vault/lock-events.js";
import { acquireExclusiveGuestLease } from "./vault/vault-shared-locks.js";

const KEY = "opensesame.guest.pending-return-signout.v1";
type Pending = {
  value: GuestContinuation;
  switching: boolean;
  persisted: boolean;
  release: (() => Promise<void>) | null;
  work: Promise<void> | null;
};
type View = Readonly<{
  busy: boolean;
  error: string | null;
  complete?: boolean;
}>;
let pending: Pending | null = null;
let view: View | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function subscribeGuestReturnSignOut(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function guestReturnSignOutSnapshot(): View | null {
  return view;
}

function remember(value: GuestContinuation, switching: boolean): boolean {
  try {
    sessionStore().setItem(KEY, JSON.stringify({ value, switching }));
    return true;
  } catch {
    return false;
  }
}

export function restoreGuestReturnSignOut(): void {
  if (pending) return;
  let storage: ReturnType<typeof maybeSessionStore>;
  try {
    storage = maybeSessionStore();
  } catch {
    return;
  }
  if (!storage) return;
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return;
  }
  if (!raw) {
    if (guestSignOutBarrierActive()) {
      view = {
        busy: false,
        error: "Sign-out is not finished. Retry sign-out before continuing.",
      };
      emit();
      return;
    }
    if (view?.error) {
      view = null;
      emit();
    }
    return;
  }
  try {
    const parsed: { value?: unknown; switching?: unknown } = JSON.parse(raw);
    const value = parseGuestContinuation(JSON.stringify(parsed.value));
    if (!value) {
      view = {
        busy: false,
        error:
          "Sign-out could not be verified. Keep this tab open and contact your administrator.",
      };
      emit();
      return;
    }
    pending = {
      value,
      switching: parsed.switching === true,
      persisted: true,
      release: null,
      work: null,
    };
    generation += 1;
    view = { busy: false, error: null };
    emit();
    retryGuestReturnSignOut();
  } catch {
    view = {
      busy: false,
      error:
        "Sign-out could not be verified. Keep this tab open and contact your administrator.",
    };
    emit();
  }
}

function mayReportSignedOut(
  epoch: ReturnType<typeof identitySessionEpoch>,
  revision: ReturnType<typeof identitySessionRevision>,
  federationGeneration: ReturnType<typeof federationSessionGeneration>,
): boolean {
  return (
    identitySessionEpoch() === epoch &&
    identitySessionRevision() === revision &&
    federationSessionGeneration() === federationGeneration &&
    !currentSession() &&
    !federationCurrentSessionSeam.load() &&
    !listNotices().some((notice) => notice.id === "session.signout-incomplete")
  );
}

async function run(current: Pending): Promise<void> {
  view = { busy: true, error: null };
  emit();
  const epoch = identitySessionEpoch();
  const revision = identitySessionRevision();
  const federationGeneration = federationSessionGeneration();
  try {
    if (!current.persisted) {
      current.persisted = remember(current.value, current.switching);
      if (!current.persisted)
        throw new Error("Could not save the sign-out request.");
    }
    announceGuestSignOut(current.value.tomb);
    current.release ??= await acquireExclusiveGuestLease(
      current.value.tomb,
      true,
    );
    await revokeStoredGuestReturn(current.value);
    await settleRevokes();
    if (!claimRevokedGuestBarrier())
      throw new Error("The guest sign-out could not be verified.");
    await current.release();
    current.release = null;
    if (pending !== current) return;
    if (guestSignOutCleanupIncomplete() || !clearGuestSignOutBarrier())
      throw new Error("The guest sign-out could not be verified.");
    try {
      sessionStore().removeItem(KEY);
    } catch {
      /* A replay still fails against the revoked record. */
    }
    pending = null;
    forgetGuestContinuation(current.value.tomb);
    try {
      if (mayReportSignedOut(epoch, revision, federationGeneration))
        storeAuthOutcome(
          current.switching
            ? { kind: "signed_out", switching: true }
            : { kind: "signed_out" },
        );
    } catch {
      /* The revoked return remains closed even if the banner cannot be stored. */
    }
    const completed: View = { busy: false, error: null, complete: true };
    view = completed;
    emit();
    setTimeout(() => {
      if (view === completed) {
        view = null;
        emit();
      }
    }, 5000);
  } catch {
    if (pending === current) {
      view = {
        busy: false,
        error:
          "Sign-out is not finished. Keep this tab open, close other tabs using this guest, check browser storage, and try again.",
      };
      emit();
    }
    throw new Error("Finish signing out the previous guest before continuing.");
  }
}

function attempt(): Promise<void> {
  const current = pending;
  if (!current)
    return guestSignOutBarrierActive() || view?.error
      ? Promise.reject(new Error("Sign-out could not be verified."))
      : Promise.resolve();
  if (!current.work) {
    const work = Promise.resolve().then(() => run(current));
    current.work = work;
    void work
      .finally(() => {
        if (current.work === work) current.work = null;
      })
      .catch(() => undefined);
  }
  return current.work;
}

export function retryGuestReturnSignOut(): void {
  void attempt().catch(() => undefined);
}

export function stageGuestReturnSignOut(
  value: GuestContinuation,
  switching: boolean,
): void {
  if (pending) return;
  markGuestSignOutBarrier();
  const persisted = remember(value, switching);
  pending = { value, switching, persisted, release: null, work: null };
  generation += 1;
  view = { busy: false, error: null };
  emit();
}

export function guestReturnSignOutPending(): boolean {
  return pending !== null;
}

export function guestReturnSignOutHolds(tomb: string): boolean {
  return guestSignOutBarrierActive() || pending?.value.tomb === tomb;
}

/** Fence a guest operation against a sign-out that begins after its awaits. */
export function captureGuestReturnSignOutCheck(
  requireDurable = false,
): () => void {
  if (requireDurable && isLocalOnlyGuest())
    throw new Error(
      "This vault is local only. Sign out and start a new guest session to connect services.",
    );
  if (pending || view?.error || guestSignOutBarrierActive())
    throw new Error("Finish signing out the previous guest before continuing.");
  const original = generation;
  const epoch = captureGuestReturnEpoch();
  if (requireDurable && epoch === null)
    throw new Error(
      "This browser cannot securely verify the sign-in. Enable persistent storage and try again.",
    );
  return () => {
    if (epoch !== null) assertGuestReturnEpoch(epoch);
    if (
      pending ||
      view?.error ||
      guestSignOutBarrierActive() ||
      generation !== original
    )
      throw new Error(
        "Finish signing out the previous guest before continuing.",
      );
  };
}

/** A new guest must not begin while an earlier guest's sign-out is pending. */
export async function settleGuestReturnSignOut(): Promise<void> {
  restoreGuestReturnSignOut();
  await attempt();
  if (view?.error || guestSignOutBarrierActive())
    throw new Error("Finish signing out the previous guest before continuing.");
  if (view?.complete) {
    view = null;
    emit();
  }
}
