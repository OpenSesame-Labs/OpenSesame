/** The worker variant selected before the shared core script evaluates. */
export type WorkerVariant = "core-only" | "push";

/**
 * `sw.js` is also imported by the classic `sw-push.js` wrapper. A direct
 * registration has no marker and is therefore core-only. The wrapper sets
 * the only accepted override before `importScripts()` evaluates `sw.js`.
 */
export function workerVariantFromBoundary(value: unknown): WorkerVariant {
  if (value === undefined) return "core-only";
  if (value === "push") return value;
  throw new Error("Unknown service-worker variant boundary");
}
