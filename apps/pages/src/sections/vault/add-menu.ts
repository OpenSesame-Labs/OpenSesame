import { useEffect } from "react";

/**
 * The other ways to add that sit behind the Add button on a phone: Import and
 * Export. Each is a flow with its own sheet, mounted beside the button, which
 * registers one entry here while it is mounted. Holding the button draws the
 * drag area (`AddSlide`): the entry whose `slide` is `up` is chosen by sliding
 * up and released there, the one that is `down` by sliding down. A keyboard
 * or a screen reader, which cannot slide, gets the same entries as a menu.
 */
export type AddEntry = {
  id: string;
  label: string;
  /** Lower first. */
  order: number;
  /** Optional hold direction; omitted entries are available through the menu. */
  slide?: "up" | "down" | undefined;
  run: () => void;
};

const entries = new Map<string, AddEntry>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function addEntries(): AddEntry[] {
  return [...entries.values()].sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
}

/** For `useSyncExternalStore`: the entries change as flows mount. */
export function subscribeAddEntries(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addEntriesVersion(): number {
  return version;
}

/** Register an entry while the calling flow is mounted. */
export function useAddEntry(entry: AddEntry): void {
  const { id, label, order, slide, run } = entry;
  useEffect(() => {
    const own = { id, label, order, slide, run };
    entries.set(id, own);
    changed();
    return () => {
      if (entries.get(id) === own) {
        entries.delete(id);
        changed();
      }
    };
  }, [id, label, order, slide, run]);
}
