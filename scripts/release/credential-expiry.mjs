#!/usr/bin/env node
// Requires the release credential and reports when it expires.
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/name node scripts/release/credential-expiry.mjs
//
// The release stage needs a credential that outlives a single run, because
// the ordinary Actions token cannot create version tags. A credential like
// that is only safe while it is short-lived and rotated, and nothing showed
// its age. This exits non-zero when the credential is absent, exactly as the
// step it replaces did, and when GitHub refuses it as expired or revoked,
// which the release could not survive either. Otherwise it asks GitHub when
// the credential expires and raises a warning when it never does, expires
// soon, or is valid for longer than the rotation period. Those warnings never
// fail the release.
//
// The credential's value is never printed. Only its kind, read from the
// public prefix, and its expiry date are.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROTATE_WITHIN_DAYS = 14;
export const MAX_LIFETIME_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const EXPIRY_HEADER = "github-authentication-token-expiration";
const TIMEOUT_MS = 15_000;
const KINDS = [
  ["ghs_", "app"],
  ["github_pat_", "fine-grained"],
  ["ghp_", "classic"],
];

/** What kind of credential this is, from its documented public prefix. */
export function tokenKind(token) {
  return KINDS.find(([prefix]) => token.startsWith(prefix))?.[1] ?? "unknown";
}

/** The header's "2026-12-31 08:00:00 UTC" or "... -0500" as a Date. */
export function parseExpiry(header) {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{2}:?\d{2})$/.exec(
      (header ?? "").trim(),
    );
  if (!match) return undefined;
  const [, day, time, zone] = match;
  const offset = zone === "UTC" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const date = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** One finding: its level ("notice" or "warning") and what to say. */
export function assess({ kind, header, now }) {
  if (kind === "app")
    return {
      level: "notice",
      message:
        "The release credential is a GitHub App installation token. It expires within the hour.",
    };
  if (!header)
    return {
      level: "warning",
      message: `The release credential (${kind} token) has no expiry date. Replace it with a GitHub App token, or a fine-grained token that expires within ${MAX_LIFETIME_DAYS} days.`,
    };
  const expiry = parseExpiry(header);
  if (!expiry)
    return {
      level: "warning",
      message: "The release credential's expiry date could not be read.",
    };
  const days = Math.floor((expiry.getTime() - now.getTime()) / DAY);
  const date = expiry.toISOString().slice(0, 10);
  if (days <= ROTATE_WITHIN_DAYS)
    return {
      level: "warning",
      message: `The release credential expires on ${date}, in ${days} day(s). Rotate it now: the next release fails without it.`,
    };
  if (days > MAX_LIFETIME_DAYS)
    return {
      level: "warning",
      message: `The release credential expires on ${date}, in ${days} days. That is longer than the ${MAX_LIFETIME_DAYS}-day rotation period.`,
    };
  return {
    level: "notice",
    message: `The release credential expires on ${date}, in ${days} days.`,
  };
}

/**
 * Asks GitHub about the credential. A refused credential is an error; any
 * other failure is a warning.
 */
export async function inspect({ token, repository, now, fetcher = fetch }) {
  const kind = tokenKind(token);
  try {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "opensesame-release-credential",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    // 401 is GitHub refusing the credential itself: expired or revoked.
    if (response.status === 401)
      return {
        level: "error",
        message:
          "GitHub refused the release credential (HTTP 401): it has expired or been revoked. Replace it before releasing.",
      };
    // The status is the diagnosis. A response body is never echoed.
    if (!response.ok)
      return {
        level: "warning",
        message: `The release credential could not be checked: HTTP ${response.status}.`,
      };
    return assess({ kind, header: response.headers.get(EXPIRY_HEADER), now });
  } catch {
    return {
      level: "warning",
      message: "The release credential could not be checked: no response.",
    };
  }
}

async function main(env) {
  if (!env.GH_TOKEN) {
    console.error(
      "::error title=Release credential::The protected publication credential is absent.",
    );
    return 1;
  }
  const { level, message } = await inspect({
    token: env.GH_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    now: new Date(),
  });
  console.log(`::${level} title=Release credential::${message}`);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  return level === "error" ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(await main(process.env));
