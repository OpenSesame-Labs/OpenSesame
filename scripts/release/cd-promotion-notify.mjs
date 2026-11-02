/**
 * When a promotion gate fails, annotate the Actions run and comment on the
 * commit. Commit comments need contents: write on GITHUB_TOKEN. The issues
 * permission does not cover this API.
 *
 *   GATE_MAIN_CI=failure GATE_PREVIEW_SMOKE=skipped GATE_PRODUCTION=skipped \
 *     GH_TOKEN=... GITHUB_REPOSITORY=owner/name GITHUB_SHA=<40 hex> \
 *     node scripts/release/cd-promotion-notify.mjs
 *
 * CD_NOTIFY_DRY_RUN=1 writes the annotation and does not call GitHub.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readString } from "../lib/json-boundary.mjs";

export const GATE_FIELDS = Object.freeze([
  ["GATE_MAIN_CI", "main_ci"],
  ["GATE_STAGE", "stage"],
  ["GATE_PREVIEW", "preview"],
  ["GATE_PROOF", "proof"],
  ["GATE_BUILD", "build"],
  ["GATE_DEPLOY", "deploy"],
  ["GATE_NPM_PREVIEW", "npm_preview"],
  ["GATE_PREVIEW_SMOKE", "preview_smoke"],
  ["GATE_PRODUCTION", "production"],
]);

const API = "https://api.github.com";

function requireText(value, label) {
  const text = readString(value);
  if (text === undefined || text.length === 0) {
    throw new Error(`${label} is required`);
  }
  return text;
}

export function gatesFromEnv(env) {
  const gates = [];
  for (const [key, name] of GATE_FIELDS) {
    const result = readString(env[key]);
    if (result === undefined || result.length === 0) continue;
    gates.push({ name, result });
  }
  return gates;
}

export function failedGateNames(gates) {
  return gates
    .filter((gate) => gate.result === "failure")
    .map((gate) => gate.name);
}

export function promotionMessage(gates, env) {
  const failed = failedGateNames(gates);
  if (failed.length === 0) {
    throw new Error("promotion notify found no failed gate");
  }
  const sha = requireText(env.GITHUB_SHA, "GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("GITHUB_SHA must be 40 lowercase hex characters");
  }
  const workflow = readString(env.GITHUB_WORKFLOW) ?? "CD";
  const lines = [
    `CD promotion blocked on ${sha}.`,
    `Failed gate: ${failed.join(", ")}.`,
    `Workflow: ${workflow}.`,
  ];
  const runId = readString(env.GITHUB_RUN_ID);
  if (runId !== undefined && runId.length > 0) lines.push(`Run: ${runId}.`);
  const runUrl = readString(env.GITHUB_RUN_URL);
  if (runUrl !== undefined && runUrl.length > 0) lines.push(runUrl);
  const skipped = gates
    .filter((gate) => gate.result === "skipped")
    .map((gate) => gate.name);
  if (skipped.length > 0) {
    lines.push(`Skipped after the failure: ${skipped.join(", ")}.`);
  }
  return lines.join("\n");
}

export function annotationCommand(message) {
  const one = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::error title=CD promotion blocked::${one}`;
}

export async function postCommitComment(repository, sha, token, body, fetcher) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("GITHUB_SHA must be 40 lowercase hex characters");
  }
  const response = await fetcher(
    `${API}/repos/${repository}/commits/${sha}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "opensesame-cd-promotion-notify",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
      redirect: "error",
    },
  );
  if (!response.ok) {
    throw new Error(
      `commit comment failed: HTTP ${response.status} (contents: write is required)`,
    );
  }
}

export async function notifyPromotionFailure(env, deps = {}) {
  const emit = deps.emit ?? ((line) => process.stdout.write(line));
  const fetcher = deps.fetch ?? fetch;
  const message = promotionMessage(gatesFromEnv(env), env);
  emit(`${annotationCommand(message)}\n`);
  const dry = readString(env.CD_NOTIFY_DRY_RUN);
  if (dry === "1" || dry === "true") return message;
  const token = readString(env.GH_TOKEN) ?? readString(env.GITHUB_TOKEN);
  if (token === undefined || token.length === 0) {
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  }
  await postCommitComment(
    requireText(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    requireText(env.GITHUB_SHA, "GITHUB_SHA"),
    token,
    message,
    fetcher,
  );
  return message;
}

async function main() {
  await notifyPromotionFailure(process.env);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "promotion notify failed";
    console.error(message);
    process.exit(1);
  });
}
