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
const pendingCleanup = new Set<Promise<void>>();

/** Keep scheduled writes and teardown visible to callers waiting for a quiet VFS. */
export function trackVfsWork(work: Promise<void>): void {
  pendingCleanup.add(work);
  void work.then(
    () => pendingCleanup.delete(work),
    () => pendingCleanup.delete(work),
  );
}
export const trackVfsCleanup = trackVfsWork;

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
export async function vfsFlushWrites(): Promise<void> {
  await Promise.all([...tombWriteChains.values()]);
}

/** Drain this tomb without waiting on teardown that itself holds its lease. */
export async function flushTombWrites(tomb: string): Promise<void> {
  for (;;) {
    const current = tombWriteChains.get(tomb);
    if (!current) return;
    await current;
    if (tombWriteChains.get(tomb) === current) return;
  }
}

export async function vfsFlush(): Promise<void> {
  do {
    await vfsFlushWrites();
    await Promise.all([...pendingCleanup]);
  } while (pendingCleanup.size > 0);
}
