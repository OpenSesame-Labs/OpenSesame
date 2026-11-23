/**
 * Cross-tab sign-out fence for the Identity session.
 *
 * The durable principal generation (`auth-generation.ts`, sealed in the local
 * store and shared by every tab of this origin) is the sign-out epoch: it moves
 * only when someone signs out. Each document remembers the generation it last
 * saw. When it has moved, every session this document published and every
 * sign-in it has in flight belong to the ended account, so the caller retires
 * them before anything is published. The broadcast is only a wake-up hint so a
 * quiet tab redraws; receivers re-read the generation and trust nothing else.
 *
 * In session-only mode the generation is held in this document's memory, so
 * the fence applies within the tab but no further.
 */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { type BroadcastLike, openBroadcast } from "../ports.js";
import {
  advanceAuthGeneration,
  currentAuthGeneration,
  readAuthGeneration,
} from "./auth-generation.js";

const CHANNEL = "opensesame.identity-signout.v1";
let seen: number | undefined;
let channel: BroadcastLike | null | undefined;

function signOutChannel(): BroadcastLike | null {
  if (channel) return channel;
  try {
    channel = openBroadcast(CHANNEL);
  } catch {
    channel = undefined;
  }
  return channel ?? null;
}

/** True once per move of the shared generation since this document last looked. */
export function sharedSignOutObserved(): boolean {
  const generation = readAuthGeneration();
  // Storage that refuses the read proves nothing; this tab's own fence holds.
  if (generation === null) return false;
  if (seen === undefined) {
    seen = generation;
    return false;
  }
  if (generation === seen) return false;
  seen = generation;
  return true;
}

/**
 * The durable sign-out epoch, for code outside identity.ts (guest returns,
 * tomb openings) that must not finish across a sign-out in any tab. Capture
 * it before work that can yield and pass it to `assertSignOutEpoch` before
 * publishing. Null means the store refused the read: treat it as unknown and
 * refuse remote work rather than assume no sign-out happened.
 */
export function captureSignOutEpoch(): number | null {
  return readAuthGeneration();
}

/** Throws when any tab has signed out since `captured` (or it is unknown). */
export function assertSignOutEpoch(captured: number | null): void {
  if (captured === null || readAuthGeneration() !== captured)
    throw new Error("You signed out meanwhile. Sign in again.");
}

/** Move the shared generation for a local sign-out, then wake other tabs. */
export function announceSharedSignOut(): void {
  sharedSignOutObserved();
  advanceAuthGeneration();
  // Re-read: a store that refused the write must not look like a sign-out.
  seen = currentAuthGeneration();
  try {
    signOutChannel()?.postMessage({ type: "signed-out" });
  } catch {
    // A lost hint is safe: every reader re-checks the durable generation.
  }
}

/** Run `handler` when another tab says it signed out. */
export function onSharedSignOut(handler: () => void): () => void {
  const open = signOutChannel();
  if (!open) return () => undefined;
  const listener = (event: MessageEvent) => {
    const data: BoundaryValue = event.data;
    if (isJsonObject(data) && data.type === "signed-out") handler();
  };
  open.addEventListener("message", listener);
  return () => open.removeEventListener("message", listener);
}

let watching = false;

/** Call `retire` once per shared sign-out; also wakes on another tab's hint. */
export function syncSharedSignOut(retire: () => void): void {
  if (!watching) {
    watching = true;
    onSharedSignOut(() => syncSharedSignOut(retire));
  }
  if (sharedSignOutObserved()) retire();
}

/** Forget what this document saw and close its channel (tests). */
export function resetSharedSignOutForTest(): void {
  seen = undefined;
  watching = false;
  try {
    channel?.close();
  } catch {
    // already closed
  }
  channel = undefined;
}
