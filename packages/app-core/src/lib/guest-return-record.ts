/** Durable, one-use authorization for a temporary guest's provider return. */
import { originFiles } from "../ports.js";
import { atRestReady, atRestSettled } from "./at-rest/key.js";
import type { GuestContinuation } from "./guest-continuation.js";
import {
  assertGuestReturnEpoch,
  readGuestReturnEpoch,
  requireGuestReturnEpoch,
} from "./guest-return-epoch.js";
import { GUEST_RETURN_EXPIRED } from "./guest-signout-copy.js";
import { kvDurability, kvGet, kvRefresh, kvSetDurable } from "./kv.js";

const pending = new Map<string, Promise<unknown>>();
const issued = new Set<string>();
const generations = new Map<string, number>();
const keyFor = (tomb: string) => `guest-provider-return/${tomb}`;
const generation = (tomb: string) => generations.get(tomb) ?? 0;

function queue<T>(tomb: string, action: () => Promise<T>): Promise<T> {
  const next = (pending.get(tomb) ?? Promise.resolve())
    .catch(() => {})
    .then(action);
  pending.set(tomb, next);
  void next
    .finally(() => {
      if (pending.get(tomb) === next) pending.delete(tomb);
    })
    .catch(() => {});
  return next;
}

async function requirePersistent(): Promise<void> {
  const key = await atRestReady();
  if (!key.durable || !originFiles() || atRestSettled()?.durable !== true)
    throw new Error(
      "This browser cannot safely resume the guest session after navigation.",
    );
}

async function readRecord(
  tomb: string,
  check: () => void,
): Promise<string | null> {
  await requirePersistent();
  check();
  await kvRefresh(keyFor(tomb), 16384, check);
  check();
  if (kvDurability() !== "persistent")
    throw new Error(
      "This browser cannot safely resume the guest session after navigation.",
    );
  return kvGet(keyFor(tomb));
}

async function writeRecord(
  tomb: string,
  value: string,
  check: () => void,
  attempting?: () => void,
): Promise<void> {
  await requirePersistent();
  check();
  attempting?.();
  await kvSetDurable(keyFor(tomb), value, check);
  check();
  if (
    kvDurability() !== "persistent" ||
    (await readRecord(tomb, check)) !== value
  )
    throw new Error(
      "The guest connection could not be saved safely. Try again.",
    );
}

/** Issue before navigation; a missing or evicted record can never authorize a return. */
export function issueGuestReturn(
  value: GuestContinuation,
  check: () => void,
): Promise<void> {
  const tomb = value.tomb;
  const original = generation(tomb);
  const epoch = requireGuestReturnEpoch();
  const active = () => {
    check();
    assertGuestReturnEpoch(epoch);
    if (generation(tomb) !== original)
      throw new Error("The guest session ended. Connect again.");
  };
  return queue(tomb, () =>
    writeRecord(tomb, JSON.stringify({ issued: value, epoch }), active, () =>
      issued.add(tomb),
    ),
  );
}

/** Return the stamped generation only for this exact saved continuation. */
function issuedEpoch(
  raw: string | null,
  value: GuestContinuation,
): string | null {
  if (!raw) return null;
  try {
    const record: { issued?: unknown; epoch?: unknown } = JSON.parse(raw);
    return typeof record.epoch === "string" &&
      JSON.stringify(record.issued) === JSON.stringify(value)
      ? record.epoch
      : null;
  } catch {
    return null;
  }
}

/** Called while holding the guest's exclusive open lease, before publication. */
export async function consumeGuestReturn(
  value: GuestContinuation,
  check: () => void,
): Promise<void> {
  const epoch = issuedEpoch(await readRecord(value.tomb, check), value);
  if (
    !epoch ||
    epoch !== readGuestReturnEpoch() ||
    value.deadline <= Date.now()
  )
    throw new Error(GUEST_RETURN_EXPIRED);
  const active = () => {
    check();
    assertGuestReturnEpoch(epoch);
  };
  await writeRecord(value.tomb, JSON.stringify({ consumed: true }), active);
}

/** Revoke a return before releasing the guest's exclusive lease on lock. */
export function revokeGuestReturns(tomb: string): Promise<void> {
  generations.set(tomb, generation(tomb) + 1);
  if (!issued.has(tomb) && !pending.has(tomb)) return Promise.resolve();
  return queue(tomb, async () => {
    if (!issued.has(tomb)) return;
    await writeRecord(tomb, JSON.stringify({ revoked: true }), () => {});
    issued.delete(tomb);
  });
}

export function guestReturnGeneration(tomb: string): number {
  return generation(tomb);
}

/** A callback tab can end an issuance even after the issuing document exited. */
export function revokeStoredGuestReturn(
  value: GuestContinuation,
): Promise<void> {
  const tomb = value.tomb;
  generations.set(tomb, generation(tomb) + 1);
  return queue(tomb, async () => {
    const current = await readRecord(tomb, () => {});
    if (issuedEpoch(current, value))
      await writeRecord(tomb, JSON.stringify({ revoked: true }), () => {});
    issued.delete(tomb);
  });
}
