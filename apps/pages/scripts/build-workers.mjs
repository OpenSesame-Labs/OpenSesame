#!/usr/bin/env node
/**
 * Build the service-worker variants that are not `sw.js` (ownership.md §4.7).
 *
 * `vite build` (with vite-plugin-pwa) has already written `dist/`, including
 * `dist/sw.js`, the core-only worker. This script then:
 *
 *   1. decides which extra variants this distribution ships — the
 *      `OPENSESAME_DISTRIBUTED_WORKERS` comma list when set (S07's plugin
 *      exports it), else `dist/capability-distribution.json`'s
 *      `workerVariants`, else every variant;
 *   2. builds `src/sw-push.ts` → `dist/sw-push.js` through
 *      `vite.sw-push.config.ts`, binding its classic `importScripts()` URL to
 *      the exact SHA-256 of `sw.js`; both variants execute one core body and
 *      therefore derive the same release id and offline manifest;
 *   3. checks the truth of the split (P-TRUTH, PWA-01): `dist/sw.js` must
 *      register no `push` or `notificationclick` handler, and every emitted
 *      variant must exist.
 *
 * Usage: node scripts/build-workers.mjs        (from apps/pages)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile } from "vite";
import {
  assertPushWorkerCore,
  coreWorkerImport,
} from "./lib/push-worker-core.mjs";
import { assertSamlWorkerFresh } from "./saml-worker-freshness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `PAGES_OUT_DIR` names another build's output (`build:push-verify`), relative
// to apps/pages; the default is `dist`.
const dist = join(root, process.env.PAGES_OUT_DIR ?? "dist");

/** Variants beyond the core-only `sw.js`, and the config that builds each. */
const EXTRA_VARIANTS = new Map([
  ["push", { config: "vite.sw-push.config.ts", output: "sw-push.js" }],
]);

const isText = (value) =>
  Object.prototype.toString.call(value) === "[object String]";

const PUSH_HANDLER =
  /addEventListener\(\s*["'`](?:push|notificationclick)["'`]/;

function distributedVariants(env) {
  const fromEnv = env.OPENSESAME_DISTRIBUTED_WORKERS;
  if (fromEnv !== undefined) {
    return new Set(
      fromEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
  const contract = join(dist, "capability-distribution.json");
  if (existsSync(contract)) {
    try {
      const parsed = JSON.parse(readFileSync(contract, "utf8"));
      if (Array.isArray(parsed.workerVariants)) {
        return new Set(
          parsed.workerVariants.map((v) => v?.id).filter((id) => isText(id)),
        );
      }
    } catch {
      // Fall through: an unreadable contract builds everything.
    }
  }
  return new Set(EXTRA_VARIANTS.keys());
}

function assertCoreWorkerHasNoPush() {
  const core = join(dist, "sw.js");
  if (!existsSync(core)) {
    throw new Error(`build-workers: ${core} is missing; run vite build first`);
  }
  const source = readFileSync(core, "utf8");
  if (PUSH_HANDLER.test(source)) {
    throw new Error(
      "build-workers: dist/sw.js registers a push or notificationclick handler; the core-only worker must not (PWA-01)",
    );
  }
}

async function buildVariant(id, coreImport) {
  const variant = EXTRA_VARIANTS.get(id);
  if (!variant) {
    console.log(
      `build-workers: no extra script for variant "${id}" (core-only ships as sw.js)`,
    );
    return;
  }
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    join(root, variant.config),
    root,
  );
  if (!loaded)
    throw new Error(`build-workers: could not load ${variant.config}`);
  const config = loaded.config;
  await build({
    ...config,
    configFile: false,
    logLevel: "warn",
    define: {
      ...(config.define ?? {}),
      __OPENSESAME_CORE_WORKER_URL__: JSON.stringify(coreImport.url),
    },
  });
  const out = join(dist, variant.output);
  if (!existsSync(out))
    throw new Error(`build-workers: ${out} was not emitted`);
  const source = readFileSync(out, "utf8");
  assertPushWorkerCore(source, coreImport);
  if (!PUSH_HANDLER.test(source)) {
    throw new Error(`build-workers: ${variant.output} carries no push handler`);
  }
  console.log(
    `build-workers: wrote ${process.env.PAGES_OUT_DIR ?? "dist"}/${variant.output} (${source.length} bytes)`,
  );
}

async function main() {
  assertSamlWorkerFresh();
  assertCoreWorkerHasNoPush();
  const wanted = distributedVariants(process.env);
  const coreImport = coreWorkerImport(dist);
  for (const id of wanted) {
    if (id === "core-only") continue;
    await buildVariant(id, coreImport);
  }
  const skipped = [...EXTRA_VARIANTS.keys()].filter((id) => !wanted.has(id));
  for (const id of skipped) {
    console.log(
      `build-workers: variant "${id}" not distributed; ${EXTRA_VARIANTS.get(id).output} not emitted`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
