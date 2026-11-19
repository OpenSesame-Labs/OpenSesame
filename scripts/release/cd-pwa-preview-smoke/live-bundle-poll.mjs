/**
 * Prove the Vite shell chunks linked from staged index.html are on the live
 * Pages CDN before Playwright runs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readString } from "../../lib/json-boundary.mjs";
import { pollUntilDeadline } from "../cd-preview-smoke-registry.mjs";
import { normalizePagesBase } from "./prepare-vars.mjs";
import { cdnPollBudget, sharedCdnDeadlineEndMs } from "./retry-budget.mjs";
import { expandDynamicShellImports } from "./shell-dynamic-imports.mjs";
import { shellAssetRefs } from "./shell-html-refs.mjs";

export {
  cssUrlRefsFromStylesheet,
  dynamicImportRefsFromJs,
} from "./shell-dynamic-imports.mjs";

const MAX_SHELL_ASSET_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function normalizeDistRelative(pathPart, ref) {
  const parts = [];
  for (const part of pathPart.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(`shell asset escapes dist: ${ref}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`shell asset path is empty: ${ref}`);
  }
  return parts.join("/");
}

/** Path under the Pages base, or undefined when the URL is another origin. */
export function shellAssetRelative(ref, pagesBase) {
  const base = new URL(pagesBase);
  let pathPart = ref.trim();
  if (pathPart.length === 0) return undefined;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(pathPart)) {
    let absolute;
    try {
      absolute = new URL(pathPart, base);
    } catch {
      return undefined;
    }
    if (absolute.origin !== base.origin) return undefined;
    pathPart = absolute.pathname;
  } else {
    pathPart = pathPart.replace(/[?#].*$/u, "");
  }
  const prefix = base.pathname;
  if (pathPart.startsWith(prefix)) {
    pathPart = pathPart.slice(prefix.length);
  } else if (pathPart.startsWith("/")) {
    throw new Error(`shell asset ${ref} is outside Pages base ${prefix}`);
  }
  return normalizeDistRelative(pathPart, ref);
}

function readIndexHtml(distDir) {
  try {
    return readFileSync(join(distDir, "index.html"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("staged index.html is missing");
    }
    throw error;
  }
}

function stagedFilePath(distDir, distRelative) {
  const root = resolve(distDir);
  const abs = resolve(root, distRelative);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (abs !== root && !abs.startsWith(rootPrefix)) {
    throw new Error(`shell asset escapes dist: ${distRelative}`);
  }
  return abs;
}

export function listStagedShellAssetPaths(distDir, pagesBase) {
  const root = resolve(distDir);
  const base = normalizePagesBase(pagesBase);
  const seen = new Set();
  const htmlPaths = [];
  for (const ref of shellAssetRefs(readIndexHtml(root))) {
    const distRelative = shellAssetRelative(ref, base);
    if (distRelative === undefined || seen.has(distRelative)) continue;
    seen.add(distRelative);
    htmlPaths.push(stagedFilePath(root, distRelative));
  }
  return expandDynamicShellImports(
    root,
    base,
    htmlPaths,
    distRelativeOf,
    stagedFilePath,
    shellAssetRelative,
  );
}

function distRelativeOf(distDir, abs) {
  return relative(distDir, abs).split(sep).join("/");
}

function readStagedShellAssets(distDir, pagesBase) {
  const paths = listStagedShellAssetPaths(distDir, pagesBase);
  if (paths.length === 0) {
    throw new Error(
      "staged index.html has no shell script, modulepreload, or stylesheet assets",
    );
  }
  return paths.map((abs) => {
    const distRelative = distRelativeOf(distDir, abs);
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`staged shell asset missing: ${distRelative}`);
      }
      throw error;
    }
    return {
      relative: distRelative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function mismatch(distRelative, detail) {
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

async function releaseResponseBody(response) {
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

async function readStreamChunk(reader, distRelative, chunkTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("body read timed out")),
          chunkTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "body read failed";
    throw mismatch(distRelative, detail);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response,
  distRelative,
  bodyDeadlineAt,
  now = Date.now,
  perChunkCapMs = FETCH_TIMEOUT_MS,
) {
  const declared = declaredLength(response);
  if (declared !== undefined && declared > MAX_SHELL_ASSET_BYTES) {
    throw mismatch(distRelative, `body exceeds ${MAX_SHELL_ASSET_BYTES} bytes`);
  }
  const stream = response.body;
  if (stream === null) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_SHELL_ASSET_BYTES) {
      throw mismatch(
        distRelative,
        `body exceeds ${MAX_SHELL_ASSET_BYTES} bytes`,
      );
    }
    return bytes;
  }
  let reader;
  try {
    reader = stream.getReader();
  } catch {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_SHELL_ASSET_BYTES) {
      throw mismatch(
        distRelative,
        `body exceeds ${MAX_SHELL_ASSET_BYTES} bytes`,
      );
    }
    return bytes;
  }
  const chunks = [];
  let total = 0;
  const perReadCapEnd = now() + perChunkCapMs;
  const readEndsAt =
    bodyDeadlineAt > now()
      ? Math.min(bodyDeadlineAt, perReadCapEnd)
      : perReadCapEnd;
  try {
    while (true) {
      if (now() > readEndsAt) {
        throw mismatch(distRelative, "body read timed out");
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
      if (total > MAX_SHELL_ASSET_BYTES) {
        throw mismatch(
          distRelative,
          `body exceeds ${MAX_SHELL_ASSET_BYTES} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("live shell asset")
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : "body read failed";
    throw mismatch(distRelative, detail);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

async function assertLiveAsset(
  asset,
  pagesBase,
  fetcher,
  timeoutMs,
  bodyDeadlineAt,
  now,
  perChunkReadMs,
) {
  const url = new URL(asset.relative, pagesBase);
  let response;
  try {
    response = await fetcher(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request failed";
    throw mismatch(asset.relative, detail);
  }
  if (!response?.ok) {
    await releaseResponseBody(response);
    const status = response?.status ?? "error";
    throw mismatch(asset.relative, `HTTP ${status}`);
  }
  const body = await readBoundedBody(
    response,
    asset.relative,
    bodyDeadlineAt,
    now,
    perChunkReadMs,
  );
  const live = createHash("sha256").update(body).digest("hex");
  if (live !== asset.sha256) {
    throw mismatch(
      asset.relative,
      `sha256 ${live.slice(0, 12)} != ${asset.sha256.slice(0, 12)}`,
    );
  }
}

async function assertLiveShellAssets(
  assets,
  pagesBase,
  fetcher,
  timeoutMs,
  bodyDeadlineAt,
  now,
  matched,
  perChunkReadMs,
  enforcePerAssetDeadline,
) {
  for (const asset of assets) {
    if (matched.has(asset.relative)) continue;
    if (enforcePerAssetDeadline && now() > bodyDeadlineAt) {
      throw mismatch(asset.relative, "CDN poll deadline expired");
    }
    await assertLiveAsset(
      asset,
      pagesBase,
      fetcher,
      timeoutMs,
      bodyDeadlineAt,
      now,
      perChunkReadMs,
    );
    matched.add(asset.relative);
  }
}

export async function pollLiveShellAssets(env, deps = {}) {
  const pagesBase = normalizePagesBase(env.PAGES_URL);
  const distRaw = readString(env.STAGED_DIST);
  if (distRaw === undefined || distRaw.length === 0) {
    throw new Error("STAGED_DIST is required");
  }
  const assets = readStagedShellAssets(resolve(distRaw), pagesBase);
  const { deadlineMs, pollMs } = cdnPollBudget(env);
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const perChunkReadMs = deps.readTimeoutMs ?? FETCH_TIMEOUT_MS;
  const pollStartedAt = now();
  const sharedStarted = readString(env.PWA_SMOKE_CDN_STARTED_MS);
  const deadlineEndMs =
    deps.cdnDeadlineEndMs ??
    (sharedStarted !== undefined
      ? sharedCdnDeadlineEndMs(env, pollStartedAt)
      : pollStartedAt + deadlineMs);
  const remainingMs = Math.max(0, deadlineEndMs - now());
  const matched = new Set();
  const started = now();
  await pollUntilDeadline(
    remainingMs,
    pollMs,
    sleep,
    () =>
      assertLiveShellAssets(
        assets,
        pagesBase,
        fetcher,
        fetchTimeoutMs,
        deadlineEndMs,
        now,
        matched,
        perChunkReadMs,
        deadlineMs > 0,
      ),
    now,
  );
  const elapsedMs = now() - started;
  const digestPreview = assets
    .slice(0, 3)
    .map((asset) => `${asset.relative} sha256=${asset.sha256.slice(0, 12)}…`)
    .join(", ");
  const more = assets.length > 3 ? ` (+${assets.length - 3} more)` : "";
  console.log(
    `live shell poll matched ${assets.length} assets in ${elapsedMs}ms: ${digestPreview}${more}`,
  );
  return assets.map((asset) => asset.relative);
}

export { shellAssetRefs } from "./shell-html-refs.mjs";
export { readBoundedBody };
