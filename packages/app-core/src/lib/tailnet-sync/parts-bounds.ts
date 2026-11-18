/** Bounded reads from an untrusted ciphertext drive. */
import { DRIVE_TIMEOUT_MS, DriveError } from "./client.js";

export const MAX_DRIVE_PART_LIST_BYTES = 2 * 1024 * 1024;
export const MAX_DRIVE_PARTS = 65_536;

export async function readPartResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new DriveError("The drive response exceeds the size limit.", 502);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DriveError("The drive response timed out.", 502)),
      DRIVE_TIMEOUT_MS,
    );
  });
  // Allocate one bounded buffer: a peer may deliberately fragment the stream
  // into a very large number of tiny chunks.
  const bytes = new Uint8Array(limit);
  let total = 0;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      if (result.value.byteLength > limit - total)
        throw new DriveError("The drive response exceeds the size limit.", 502);
      bytes.set(result.value, total);
      total += result.value.byteLength;
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  return bytes.slice(0, total);
}
