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

export function cdnRetryBudget(env) {
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
  return { attempts: Math.floor(deadlineMs / pollMs) + 1, intervalMs: pollMs };
}

export function registryRetryBudget(env) {
  if (readString(env.CD_REGISTRY_VERSION_CONFIRMED) === "1") {
    return { attempts: 0, intervalMs: DEFAULT_CDN_POLL_MS };
  }
  const { deadlineMs, pollMs } = registryBudget(env);
  return { attempts: Math.floor(deadlineMs / pollMs) + 1, intervalMs: pollMs };
}
