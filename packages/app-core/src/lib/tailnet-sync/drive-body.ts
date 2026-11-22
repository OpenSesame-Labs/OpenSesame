/** Bounded and cancellable reads from an untrusted ciphertext drive. */
import { DRIVE_TIMEOUT_MS, DriveError } from "./drive-errors.js";

/**
 * A stalled body gets the normal request timeout. Five minutes overall lets a
 * large snapshot keep moving over cellular without allowing an endless stream.
 */
export const DRIVE_BODY_IDLE_TIMEOUT_MS = DRIVE_TIMEOUT_MS;
export const DRIVE_BODY_MAX_TIMEOUT_MS = 5 * 60_000;

/** A discarded response must not keep an untrusted stream open. */
export function discardDriveBody(response: Response): void {
  try {
    // A peer can make cancellation itself stall. Request it, but never wait.
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A closed or otherwise unusable stream needs no further handling.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort, even if the browser rejects it immediately.
  }
}

/**
 * Read a whole body under idle, absolute time and byte limits. Parts retain
 * their existing strict numeric length check; snapshots count the actual body
 * even if a proxy combines or omits that optional header.
 */
export async function readDriveBody(
  response: Response,
  limit: number,
  { validateLength = false }: { validateLength?: boolean } = {},
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    const oversized = /^\d+$/.test(declared) && length > limit;
    const invalidForParts =
      validateLength &&
      (!Number.isSafeInteger(length) || length < 0 || length > limit);
    if (oversized || invalidForParts) {
      discardDriveBody(response);
      throw new DriveError("The drive answered with an oversized body.", 502);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const startedAt = performance.now();
  const expiresAt = startedAt + DRIVE_BODY_MAX_TIMEOUT_MS;
  let idleAt = startedAt + DRIVE_BODY_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const check = () => {
      const remaining = Math.min(expiresAt, idleAt) - performance.now();
      if (remaining <= 0) {
        reject(new DriveError("The drive response timed out.", 502));
      } else {
        timer = setTimeout(check, remaining);
      }
    };
    timer = setTimeout(check, DRIVE_BODY_IDLE_TIMEOUT_MS);
  });
  const collect = async (): Promise<Uint8Array> => {
    // Grow a single bounded buffer instead of retaining one object per chunk.
    // Small replies do not allocate the full snapshot ceiling.
    let bytes = new Uint8Array(0);
    let total = 0;
    while (true) {
      // A stream can produce continuously without returning to the timer task.
      if (performance.now() >= Math.min(expiresAt, idleAt))
        throw new DriveError("The drive response timed out.", 502);
      const result = await reader.read();
      const now = performance.now();
      if (now >= Math.min(expiresAt, idleAt))
        throw new DriveError("The drive response timed out.", 502);
      if (result.done) break;
      const needed = total + result.value.byteLength;
      if (needed > limit)
        throw new DriveError("The drive answered with an oversized body.", 502);
      if (result.value.byteLength > 0)
        idleAt = now + DRIVE_BODY_IDLE_TIMEOUT_MS;
      if (needed > bytes.byteLength) {
        const capacity = Math.min(
          limit,
          Math.max(needed, bytes.byteLength * 2, 4096),
        );
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(result.value, total);
      total = needed;
    }
    return bytes.slice(0, total);
  };
  try {
    // Race once: per-chunk races retain a deadline reaction for every chunk.
    return await Promise.race([collect(), deadline]);
  } finally {
    clearTimeout(timer);
    cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // Some older stream implementations refuse to release a pending read.
    }
  }
}
