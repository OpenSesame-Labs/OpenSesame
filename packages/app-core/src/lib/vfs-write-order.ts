/** Per-tomb promise ordering only; receives no key, owner or admission. */
/**
 * Sealed writes are read-modify-write against the tomb index, so they run
 * one at a time per tomb — a body persist and a prefs write can never lose
 * each other's index entries.
 */
/** An opaque active queue turn carries ordering only, never keys or authority. */
export type TombWriteTurn = Readonly<{ tomb: string }>;
const activeTurns = new WeakMap<TombWriteTurn, string>();
export function assertTombWriteTurn(tomb: string, turn: TombWriteTurn): void {
  if (activeTurns.get(turn) !== tomb)
    throw new Error("Original tomb write turn is not active.");
}
export function withTombWriteTurn<T>(
  tomb: string,
  work: (turn: TombWriteTurn) => Promise<T>,
): Promise<T> {
  return enqueueTombWrite(tomb, async () => {
    const turn = Object.freeze({ tomb });
    activeTurns.set(turn, tomb);
    try {
      return await work(turn);
    } finally {
      activeTurns.delete(turn);
    }
  });
}
const tombWriteChains = new Map<string, Promise<unknown>>();
/** Writes scheduled behind other work, before they reach a tomb's queue. */
const scheduledWrites = new Set<Promise<void>>();

/** Keep a scheduled write visible to callers waiting for a quiet VFS. */
export function trackVfsWork(work: Promise<void>): void {
  scheduledWrites.add(work);
  const settle = () => scheduledWrites.delete(work);
  void work.then(settle, settle);
}

export function enqueueTombWrite<T>(
  tomb: string,
  op: () => Promise<T>,
  turn?: TombWriteTurn,
): Promise<T> {
  if (turn) {
    assertTombWriteTurn(tomb, turn);
    return op();
  }
  const run = (tombWriteChains.get(tomb) ?? Promise.resolve()).then(op);
  tombWriteChains.set(
    tomb,
    run.catch(() => undefined),
  );
  return run;
}

/** Settle every queued tomb write — for tests that need a quiet store. */
export async function vfsFlush(): Promise<void> {
  do {
    await Promise.all([...tombWriteChains.values()]);
    await Promise.allSettled([...scheduledWrites]);
  } while (scheduledWrites.size > 0);
  await Promise.all([...tombWriteChains.values()]);
}
