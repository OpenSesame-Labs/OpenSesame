import { readString } from "../../lib/json-boundary.mjs";
import { registryBudget } from "../cd-preview-smoke.mjs";

export const DEFAULT_CDN_DEADLINE_MS = 120_000;
export const DEFAULT_CDN_POLL_MS = 2_000;

function readBoundedInt(value, fallback, label, min) {
  if (value === undefined || value === "") return fallback;
  const text = readString(value);
  if (text === undefined || !/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (parsed < min) {
    throw new Error(`${label} must be at least ${min}`);
  }
  return parsed;
}

/** Absolute deadline for the shared hurl + shell-poll CDN window. */
export function sharedCdnDeadlineEndMs(env, nowMs = Date.now()) {
  const { deadlineMs } = cdnPollBudget(env);
  const started = readBoundedInt(
    env.PWA_SMOKE_CDN_STARTED_MS,
    nowMs,
    "PWA_SMOKE_CDN_STARTED_MS",
    0,
  );
  return started + deadlineMs;
}

export function remainingSharedCdnMs(env, nowMs = Date.now()) {
  return Math.max(0, sharedCdnDeadlineEndMs(env, nowMs) - nowMs);
}

/** Cap fetch abort at the remainder of the shared CDN window, or full timeout. */
export function fetchAbortTimeoutMs(timeoutMs, bodyDeadlineAt, now) {
  const at = now();
  return bodyDeadlineAt > at
    ? Math.min(timeoutMs, Math.max(1, bodyDeadlineAt - at))
    : timeoutMs;
}

/** Same shared Pages CDN window for `cdnRetryBudget` and shell poll. */
export function cdnPollBudget(env) {
  const deadlineMs = readBoundedInt(
    env.PWA_SMOKE_CDN_DEADLINE_MS,
    DEFAULT_CDN_DEADLINE_MS,
    "PWA_SMOKE_CDN_DEADLINE_MS",
    0,
  );
  const pollMs = readBoundedInt(
    env.PWA_SMOKE_CDN_POLL_MS,
    DEFAULT_CDN_POLL_MS,
    "PWA_SMOKE_CDN_POLL_MS",
    1,
  );
  return { deadlineMs, pollMs };
}

/** Hurl `--retry` is per request; keep retries inside one wall-clock CDN window. */
export function cdnRetryBudget(env) {
  const { deadlineMs, pollMs } = cdnPollBudget(env);
  const retries = Math.floor(deadlineMs / pollMs);
  return {
    retries,
    intervalMs: pollMs,
    maxTimeSec: Math.max(1, Math.ceil(deadlineMs / 1000)),
  };
}

export function registryRetryBudget(env) {
  if (readString(env.CD_REGISTRY_VERSION_CONFIRMED) === "1") {
    return { attempts: 0, intervalMs: DEFAULT_CDN_POLL_MS };
  }
  const { deadlineMs, pollMs } = registryBudget(env);
  return { attempts: Math.floor(deadlineMs / pollMs) + 1, intervalMs: pollMs };
}
