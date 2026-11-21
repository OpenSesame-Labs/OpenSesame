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
  // Do not reserve `maxBytes` up front. Freeze admission is 16 MiB; a short
  // body must not pin that much, and a chunk past the cap is not retained.
  const chunkLimit = 64 * 1024;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let byteReader: ReadableStreamBYOBReader | undefined;
  try {
    byteReader = response.body.getReader({ mode: "byob" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    reader = response.body.getReader();
  }
  const active = byteReader ?? reader;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("invocation response timed out")),
      INVOCATION_RESPONSE_TIMEOUT_MS,
    );
  });
  const accept = (value: Uint8Array) => {
    if (value.byteLength > maxBytes - total) {
      throw new Error("invocation response exceeds limit");
    }
    if (value.byteLength === 0) return;
    chunks.push(value);
    total += value.byteLength;
  };
  try {
    if (byteReader) {
      while (true) {
        const size = Math.min(chunkLimit, maxBytes - total + 1);
        const buffer = new Uint8Array(size);
        const result = await Promise.race([byteReader.read(buffer), deadline]);
        if (result.done) break;
        accept(result.value);
      }
    } else if (reader) {
      while (true) {
        const result = await Promise.race([reader.read(), deadline]);
        if (result.done) break;
        accept(result.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return overlapCast(JSON.parse(text));
  } finally {
    clearTimeout(timer);
    void active?.cancel().catch(() => undefined);
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
