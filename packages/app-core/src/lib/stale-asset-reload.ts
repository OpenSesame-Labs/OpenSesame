/**
 * One automatic reload per executing build when a lazy chunk fails.
 *
 * A successful shell import does not prove that every lazy chunk is present.
 * Keep the shot across reloads of the same build; a new immutable entry can
 * try again. Without durable tab storage, do not start an unbounded loop.
 */

const KEY = "os-stale-asset-reload";

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

export const staleAssetReload = {
  /** Bind the guard to the immutable module that is executing this document. */
  beginBuild(moduleUrl: string): void {
    try {
      const url = new URL(moduleUrl);
      const match = url.pathname.match(/\/assets\/([\w.-]+-[\w-]{8,64}\.js)$/u);
      build = !url.search && !url.hash ? (match?.[1] ?? null) : null;
      const previous = storage()?.getItem(KEY);
      if (build && previous && previous !== build) this.clear();
    } catch {
      build = null;
    }
  },
  /** A reload for a missing chunk already happened for this build. */
  already(): boolean {
    try {
      return memory || storage()?.getItem(KEY) != null;
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
      const value = build ?? "1";
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
