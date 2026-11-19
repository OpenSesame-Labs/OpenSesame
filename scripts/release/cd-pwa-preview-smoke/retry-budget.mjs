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
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  if (parsed < min) {
    throw new Error(`${label} must be at least ${min}`);
  }
  return parsed;
}

/** Absolute deadline for the shared hurl + shell-poll CDN window. */
export function sharedCdnDeadlineEndMs(env) {
  const { deadlineMs } = cdnPollBudget(env);
  const startedRaw = readString(env.PWA_SMOKE_CDN_STARTED_MS);
  if (startedRaw === undefined || startedRaw === "") {
    throw new Error("PWA_SMOKE_CDN_STARTED_MS is required");
  }
  const started = readBoundedInt(
    env.PWA_SMOKE_CDN_STARTED_MS,
    undefined,
    "PWA_SMOKE_CDN_STARTED_MS",
    0,
  );
  return started + deadlineMs;
}

export function remainingSharedCdnMs(env, nowMs = Date.now()) {
  return Math.max(0, sharedCdnDeadlineEndMs(env) - nowMs);
}

/** Cap fetch abort at the remainder of the shared CDN window, or full timeout. */
export function fetchAbortTimeoutMs(
  timeoutMs,
  bodyDeadlineAt,
  now,
  enforceDeadline = true,
) {
  const at = now();
  if (bodyDeadlineAt > at) {
    return Math.min(timeoutMs, Math.max(1, bodyDeadlineAt - at));
  }
  return enforceDeadline ? 1 : timeoutMs;
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

function hurlFitsDeadline(retries, intervalMs, maxTimeSec, deadlineMs) {
  const attempts = retries + 1;
  return attempts * maxTimeSec * 1000 + retries * intervalMs <= deadlineMs;
}

/** Hurl `--retry` is per request; keep retries inside one wall-clock CDN window. */
export function cdnRetryBudget(env) {
  const { deadlineMs, pollMs } = cdnPollBudget(env);
  let retries = Math.min(Math.floor(deadlineMs / pollMs), 10_000);
  let maxTimeSec = 1;
  while (retries >= 0) {
    const attemptBudgetMs = deadlineMs - retries * pollMs;
    const attempts = retries + 1;
    if (attemptBudgetMs < attempts * 1000) {
      if (retries === 0) {
        maxTimeSec = Math.max(1, Math.floor(deadlineMs / 1000));
        break;
      }
      retries -= 1;
      continue;
    }
    maxTimeSec = Math.max(1, Math.floor(attemptBudgetMs / attempts / 1000));
    if (!hurlFitsDeadline(retries, pollMs, maxTimeSec, deadlineMs)) {
      retries -= 1;
      continue;
    }
    break;
  }
  return {
    retries,
    intervalMs: pollMs,
    maxTimeSec,
  };
}

export function registryRetryBudget(env) {
  if (readString(env.CD_REGISTRY_VERSION_CONFIRMED) === "1") {
    return { attempts: 0, intervalMs: DEFAULT_CDN_POLL_MS };
  }
  const { deadlineMs, pollMs } = registryBudget(env);
  return { attempts: Math.floor(deadlineMs / pollMs) + 1, intervalMs: pollMs };
}
