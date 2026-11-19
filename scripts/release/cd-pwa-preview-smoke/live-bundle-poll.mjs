/**
 * Prove the Vite shell chunks linked from staged index.html are on the live
 * Pages CDN before Playwright runs.
 *
 * pages.hurl matches index.html, release.json, os-runtime-config, the
 * manifest, and sw.js. Those can be fresh while /assets/main-*.js is still
 * 404 or stale, so React never mounts and the front door never appears.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readString } from "../../lib/json-boundary.mjs";
import { pollUntilDeadline } from "../cd-preview-smoke-registry.mjs";
import { normalizePagesBase } from "./prepare-vars.mjs";
import { cdnPollBudget } from "./retry-budget.mjs";

const MAX_SHELL_ASSET_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function htmlAttribute(tag, name) {
  const match = tag.match(
    new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
      "iu",
    ),
  );
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function shellAssetRefs(html) {
  const refs = [];
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/giu)) {
    const tag = match[0];
    if (match[1].toLowerCase() === "script") {
      const src = htmlAttribute(tag, "src");
      if (src !== undefined && src.length > 0) refs.push(src);
      continue;
    }
    const rel = htmlAttribute(tag, "rel");
    if (rel === undefined) continue;
    const isModulePreload = rel
      .toLowerCase()
      .split(/\s+/u)
      .includes("modulepreload");
    if (!isModulePreload) continue;
    const href = htmlAttribute(tag, "href");
    if (href !== undefined && href.length > 0) refs.push(href);
  }
  return refs;
}

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
function shellAssetRelative(ref, pagesBase) {
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

/**
 * Absolute paths of `script[src]` and `link[rel=modulepreload][href]` in
 * staged index.html. Root-absolute `/OpenSesame/...` URLs drop the Pages
 * base pathname. External origins are skipped. Document order, de-duplicated.
 */
export function listStagedShellAssetPaths(distDir, pagesBase) {
  const root = resolve(distDir);
  const base = normalizePagesBase(pagesBase);
  const seen = new Set();
  const paths = [];
  for (const ref of shellAssetRefs(readIndexHtml(root))) {
    const distRelative = shellAssetRelative(ref, base);
    if (distRelative === undefined || seen.has(distRelative)) continue;
    seen.add(distRelative);
    paths.push(stagedFilePath(root, distRelative));
  }
  return paths;
}

function distRelativeOf(distDir, abs) {
  return relative(distDir, abs).split(sep).join("/");
}

function readStagedShellAssets(distDir, pagesBase) {
  const paths = listStagedShellAssetPaths(distDir, pagesBase);
  if (paths.length === 0) {
    throw new Error(
      "staged index.html has no shell script or modulepreload assets",
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

async function readBoundedBody(response, distRelative) {
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
  try {
    while (true) {
      const { done, value } = await reader.read();
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
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

async function assertLiveAsset(asset, pagesBase, fetcher, timeoutMs) {
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
    const status = response?.status ?? "error";
    throw mismatch(asset.relative, `HTTP ${status}`);
  }
  const body = await readBoundedBody(response, asset.relative);
  const live = createHash("sha256").update(body).digest("hex");
  if (live !== asset.sha256) {
    throw mismatch(
      asset.relative,
      `sha256 ${live.slice(0, 12)} != ${asset.sha256.slice(0, 12)}`,
    );
  }
}

async function assertLiveShellAssets(assets, pagesBase, fetcher, timeoutMs) {
  for (const asset of assets) {
    await assertLiveAsset(asset, pagesBase, fetcher, timeoutMs);
  }
}

/**
 * GET each staged shell asset at `new URL(relative, pagesBase)` until its
 * sha256 matches the staged file or the CDN poll deadline expires.
 * The thrown error names the first asset that did not match.
 */
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
  const started = now();
  await pollUntilDeadline(
    deadlineMs,
    pollMs,
    sleep,
    () => assertLiveShellAssets(assets, pagesBase, fetcher, FETCH_TIMEOUT_MS),
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
