import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";

export const MAX_INVOCATION_RESPONSE_BYTES = 128 * 1024;
/** Matches Host freeze admission (`tasks_opening::MAX_RECOVERY_BODY_BYTES`). */
export const MAX_FREEZE_INTENT_RESPONSE_BYTES = 16 * 1024 * 1024;
export const INVOCATION_RESPONSE_TIMEOUT_MS = 15_000;

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<BoundaryValue> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > maxBytes
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invocation response exceeds limit");
  }
  if (!response.body) throw new Error("invocation response is empty");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("invocation response timed out")),
      INVOCATION_RESPONSE_TIMEOUT_MS,
    );
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      if (result.value.byteLength > bytes.length - total)
        throw new Error("invocation response exceeds limit");
      bytes.set(result.value, total);
      total += result.value.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, total),
    );
    return overlapCast(JSON.parse(text));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** Read a bounded receipt/invoke response before projecting it into agent-visible metadata. */
export async function readInvocationResponse(
  response: Response,
): Promise<BoundaryValue> {
  return readBoundedJsonResponse(response, MAX_INVOCATION_RESPONSE_BYTES);
}

/** Read a bounded freeze response; canonical arguments may approach Host intent limits. */
export async function readFreezeIntentResponse(
  response: Response,
): Promise<BoundaryValue> {
  return readBoundedJsonResponse(response, MAX_FREEZE_INTENT_RESPONSE_BYTES);
}