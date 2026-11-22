/// <reference lib="webworker" />

/**
 * The push-capable service worker (`sw-push.js`, ownership.md §4.7).
 *
 * A classic wrapper around the exact built `sw.js` core — shell precache,
 * plan-driven offline assets, owned caches under the `push` variant name —
 * plus the Web Push handlers (ADR 0084). The handlers are installed before
 * the core import so Chromium records them on every cold worker start.
 * `scripts/build-workers.mjs` binds the import URL to the core script's
 * SHA-256, so a core edit also changes this wrapper and the browser's imported
 * script update check sees the same bytes.
 */

import { overlapCast } from "@opensesame/os-domain";
import { installPushHandlers } from "./sw/push-handlers.js";

declare const __OPENSESAME_CORE_WORKER_URL__: string;

type PushWorkerGlobal = ServiceWorkerGlobalScope & {
  __OPENSESAME_WORKER_VARIANT__?: "push";
};

// SAFETY: this file is a service worker; globalThis is ServiceWorkerGlobalScope
// at runtime, but the TS lib types do not overlap.
const sw = overlapCast<typeof globalThis, PushWorkerGlobal>(globalThis);

// This is a classic service worker (`worker/registration.ts`). Set the marker
// before the shared core evaluates; direct `sw.js` registrations have no
// marker and remain core-only. Push listeners must be present before the
// import on a cold start; the imported core then owns install/activate/fetch.
sw.__OPENSESAME_WORKER_VARIANT__ = "push";
installPushHandlers(sw);
sw.importScripts(__OPENSESAME_CORE_WORKER_URL__);
