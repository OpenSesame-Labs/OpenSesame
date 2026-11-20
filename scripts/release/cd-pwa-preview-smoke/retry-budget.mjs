import { readString } from "../../lib/json-boundary.mjs";
import { registryBudget } from "../cd-preview-smoke.mjs";
import { FETCH_TIMEOUT_MS } from "./live-bundle-body.mjs";

export const DEFAULT_CDN_DEADLINE_MS = 120_000;
export const DEFAULT_CDN_POLL_MS = 2_000;
/** Per-attempt hurl cap, aligned with the shell-poll fetch timeout. */
export const HURL_MAX_TIME_MS = FETCH_TIMEOUT_MS;

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
  return cdnDeadlineEndMs(started, deadlineMs);
}

/**
 * One window end from `startedMs + deadlineMs`. The sum, not only the inputs,
 * must stay a safe integer: a rounded end would silently move the deadline.
 */
export function cdnDeadlineEndMs(startedMs, deadlineMs) {
  const end = startedMs + deadlineMs;
  if (!Number.isSafeInteger(end)) {
    throw new Error("CDN deadline window exceeds Number.MAX_SAFE_INTEGER");
  }
  return end;
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
  if (!enforceDeadline) return timeoutMs;
  if (bodyDeadlineAt <= at) return 1;
  return Math.min(timeoutMs, Math.max(1, bodyDeadlineAt - at));
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

function hurlFitsDeadline(retries, intervalMs, maxTimeMs, deadlineMs) {
  const attempts = retries + 1;
  return attempts * maxTimeMs + retries * intervalMs <= deadlineMs;
}

/** Hurl `--retry` is per request; keep retries inside one wall-clock CDN window. */
export function cdnRetryBudget(env) {
  const { deadlineMs, pollMs } = cdnPollBudget(env);
  // A zero deadline is a single attempt with no shared window, so the plain
  // per-request cap applies. A positive deadline also caps each attempt so
  // the whole hurl run cannot outlive the window — including sub-second
  // deadlines, which must not round up to a one-second max-time.
  const maxTimeMs =
    deadlineMs > 0 ? Math.min(HURL_MAX_TIME_MS, deadlineMs) : HURL_MAX_TIME_MS;
  let retries = Math.max(
    0,
    Math.min(
      Math.floor((deadlineMs - maxTimeMs) / (maxTimeMs + pollMs)),
      10_000,
    ),
  );
  while (
    retries > 0 &&
    !hurlFitsDeadline(retries, pollMs, maxTimeMs, deadlineMs)
  ) {
    retries -= 1;
  }
  return {
    retries,
    intervalMs: pollMs,
    maxTimeMs,
  };
}

/**
 * Hurl parses `--max-time` as whole seconds; the `ms` suffix keeps sub-second
 * budgets parseable instead of rounding them up to one second.
 */
export function hurlMaxTimeArg(maxTimeMs) {
  return `${Math.max(0, Math.round(maxTimeMs))}ms`;
}

export function registryRetryBudget(env) {
  if (readString(env.CD_REGISTRY_VERSION_CONFIRMED) === "1") {
    return { attempts: 0, intervalMs: DEFAULT_CDN_POLL_MS };
  }
  const { deadlineMs, pollMs } = registryBudget(env);
  return { attempts: Math.floor(deadlineMs / pollMs) + 1, intervalMs: pollMs };
}
