import { Buffer } from "node:buffer";

export const MAX_SHELL_ASSET_BYTES = 16 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

export function shellAssetMismatch(distRelative, detail) {
  return new Error(`live shell asset mismatch: ${distRelative} (${detail})`);
}

function declaredLength(response) {
  try {
    const raw = response.headers.get("content-length");
    if (raw === null || raw === "") return undefined;
    const size = Number(raw);
    return Number.isFinite(size) ? size : undefined;
  } catch {
    return undefined;
  }
}

async function readStreamChunk(reader, distRelative, chunkTimeoutMs) {
  let timer;
  try {
    const readPromise = reader.read();
    readPromise.catch(() => undefined);
    return await Promise.race([
      readPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("body read timed out")),
          chunkTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "body read failed";
    throw shellAssetMismatch(distRelative, detail);
  } finally {
    clearTimeout(timer);
  }
}

function oversizedShellBody(distRelative) {
  return shellAssetMismatch(
    distRelative,
    `body exceeds ${MAX_SHELL_ASSET_BYTES} bytes`,
  );
}

function assertWithinByteCap(size, distRelative) {
  if (size > MAX_SHELL_ASSET_BYTES) {
    throw oversizedShellBody(distRelative);
  }
}

async function readArrayBufferBody(response, distRelative, readEndsAt, now) {
  const remaining = Math.max(1, readEndsAt - now());
  let timer;
  try {
    const bodyPromise = response.arrayBuffer();
    bodyPromise.catch(() => undefined);
    const raw = await Promise.race([
      bodyPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("body read timed out")),
          remaining,
        );
      }),
    ]);
    const bytes = Buffer.from(raw);
    assertWithinByteCap(bytes.length, distRelative);
    return bytes;
  } catch (error) {
    rethrowShellRead(error, distRelative);
  } finally {
    clearTimeout(timer);
  }
}

function rethrowShellRead(error, distRelative) {
  if (error instanceof Error && error.message.startsWith("live shell asset")) {
    throw error;
  }
  const detail = error instanceof Error ? error.message : "body read failed";
  throw shellAssetMismatch(distRelative, detail);
}

async function readStreamBody(
  reader,
  distRelative,
  at,
  bodyDeadlineAt,
  now,
  perChunkCapMs,
  enforceDeadline,
) {
  const chunks = [];
  let total = 0;
  const perReadCapEnd = at + perChunkCapMs;
  const readEndsAt =
    enforceDeadline && bodyDeadlineAt > at
      ? Math.min(bodyDeadlineAt, perReadCapEnd)
      : perReadCapEnd;
  try {
    while (true) {
      if (now() > readEndsAt) {
        throw shellAssetMismatch(distRelative, "body read timed out");
      }
      const chunkTimeoutMs = Math.min(
        perChunkCapMs,
        Math.max(1, readEndsAt - now()),
      );
      const { done, value } = await readStreamChunk(
        reader,
        distRelative,
        chunkTimeoutMs,
      );
      if (done) break;
      const size = value?.byteLength ?? 0;
      total += size;
      assertWithinByteCap(total, distRelative);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    rethrowShellRead(error, distRelative);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedBody(
  response,
  distRelative,
  bodyDeadlineAt,
  now = Date.now,
  perChunkCapMs = FETCH_TIMEOUT_MS,
  enforceDeadline = true,
) {
  const at = now();
  if (enforceDeadline && bodyDeadlineAt <= at) {
    throw shellAssetMismatch(distRelative, "CDN poll deadline expired");
  }
  const declared = declaredLength(response);
  if (declared !== undefined && declared > MAX_SHELL_ASSET_BYTES) {
    throw oversizedShellBody(distRelative);
  }
  const perReadCapEnd = at + perChunkCapMs;
  const readEndsAt =
    enforceDeadline && bodyDeadlineAt > at
      ? Math.min(bodyDeadlineAt, perReadCapEnd)
      : perReadCapEnd;
  const stream = response.body;
  if (stream === null) {
    return readArrayBufferBody(response, distRelative, readEndsAt, now);
  }
  let reader;
  try {
    reader = stream.getReader();
  } catch {
    return readArrayBufferBody(response, distRelative, readEndsAt, now);
  }
  return readStreamBody(
    reader,
    distRelative,
    at,
    bodyDeadlineAt,
    now,
    perChunkCapMs,
    enforceDeadline,
  );
}

export async function releaseResponseBody(response) {
  if (response === null || response === undefined) return;
  const stream = response.body;
  if (stream === null || stream === undefined) {
    await response.arrayBuffer().catch(() => undefined);
    return;
  }
  try {
    const reader = stream.getReader();
    await reader.cancel().catch(() => undefined);
  } catch {
    await response.arrayBuffer().catch(() => undefined);
  }
}
