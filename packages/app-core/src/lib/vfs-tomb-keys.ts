/** Create a check-only lifetime capability; it never holds a vault key. */
import { VfsError } from "./vfs-error.js";

export function createTombLifetime(isCurrent: () => boolean): () => void {
  return () => {
    if (!isCurrent())
      throw new VfsError("locked", "Original tomb owner changed.");
  };
}

/** Track locked-to-unlocked transitions without retaining an unbounded set of tombs. */
export function createUnlockEpochTracker() {
  const epochs = new Map<string, symbol>();
  let era = Symbol("vfs-unlock-era");
  return {
    changed(tomb: string): void {
      if (!epochs.has(tomb) && epochs.size >= 256) {
        epochs.clear();
        era = Symbol("vfs-unlock-era");
      }
      epochs.set(tomb, Symbol("vfs-unlock-epoch"));
    },
    reset(): void {
      epochs.clear();
      era = Symbol("vfs-unlock-era");
    },
    capture(tomb: string): () => void {
      const expectedEra = era;
      const expectedEpoch = epochs.get(tomb);
      return createTombLifetime(
        () => era === expectedEra && epochs.get(tomb) === expectedEpoch,
      );
    },
  };
}
