/**
 * One automatic reload per executing build when a lazy chunk fails.
 *
 * A successful shell import does not prove that every lazy chunk is present.
 * Keep the shot across reloads of the same build; a new immutable entry can
 * try again. Without durable tab storage, do not start an unbounded loop.
 */

import { type BoundaryValue, isString } from "@opensesame/os-domain";

const KEY = "os-stale-asset-reload";
const MAX_BUILDS = 4;

/** This document's shot, for a host with no `sessionStorage`. */
let memory = false;
let build: string | null = null;

function storage(): Storage | null {
  const scope: { sessionStorage?: Storage } = globalThis;
  try {
    return scope.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The marker used to be one string; preserve it when upgrading an open tab. */
function attempted(store: Storage): string[] {
  const raw = store.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isString))
      return [...new Set(parsed)];
  } catch {
    // A marker from the previous version is a plain string.
  }
  return [raw];
}

export const staleAssetReload = {
  /** Bind the guard to the immutable module that is executing this document. */
  beginBuild(moduleUrl: string): void {
    try {
      const url = new URL(moduleUrl);
      const match = url.pathname.match(/\/assets\/([\w.-]+-[\w-]{8,64}\.js)$/u);
      build = !url.search && !url.hash ? (match?.[1] ?? null) : null;
    } catch {
      build = null;
    }
  },
  /** A reload for a missing chunk already happened for this build. */
  already(): boolean {
    try {
      if (memory) return true;
      const store = storage();
      if (!store) return false;
      const builds = attempted(store);
      return builds.includes(build ?? "1") || builds.length >= MAX_BUILDS;
    } catch {
      return memory;
    }
  },
  /** Return false when the guard cannot survive a navigation. */
  mark(): boolean {
    memory = true;
    try {
      const store = storage();
      if (!store) return false;
      const builds = attempted(store);
      if (builds.includes(build ?? "1") || builds.length >= MAX_BUILDS)
        return false;
      const value = JSON.stringify([...builds, build ?? "1"]);
      store.setItem(KEY, value);
      return store.getItem(KEY) === value;
    } catch {
      return false;
    }
  },
  clear(): void {
    memory = false;
    try {
      storage()?.removeItem(KEY);
    } catch {
      // The in-memory shot is already clear.
    }
  },
};
