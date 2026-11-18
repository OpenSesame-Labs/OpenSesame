/** Bounded and cancellable reads from an untrusted ciphertext drive. */
import { DRIVE_TIMEOUT_MS, DriveError } from "./drive-errors.js";

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

/** Read a whole body under one absolute deadline and a byte ceiling. */
export async function readDriveBody(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    discardDriveBody(response);
    throw new DriveError("The drive response exceeds the size limit.", 502);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const expiresAt = performance.now() + DRIVE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DriveError("The drive response timed out.", 502)),
      DRIVE_TIMEOUT_MS,
    );
  });
  const collect = async (): Promise<Uint8Array> => {
    // Grow a single bounded buffer instead of retaining one object per chunk.
    // Small replies do not allocate the full snapshot ceiling.
    let bytes = new Uint8Array(0);
    let total = 0;
    while (true) {
      // A stream can produce continuously without returning to the timer task.
      if (performance.now() >= expiresAt)
        throw new DriveError("The drive response timed out.", 502);
      const result = await reader.read();
      if (result.done) break;
      const needed = total + result.value.byteLength;
      if (needed > limit)
        throw new DriveError("The drive response exceeds the size limit.", 502);
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
  }
}
