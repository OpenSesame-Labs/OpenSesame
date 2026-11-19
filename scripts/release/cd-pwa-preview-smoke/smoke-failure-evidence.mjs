import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readString } from "../../lib/json-boundary.mjs";

const MAX_ENTRY_TEXT = 500;
const SENSITIVE =
  /(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/giu;

export function redactDiagnosticText(text) {
  const raw = String(text ?? "");
  const redacted = raw.replace(SENSITIVE, "[redacted]");
  return redacted.length > MAX_ENTRY_TEXT
    ? `${redacted.slice(0, MAX_ENTRY_TEXT)}…`
    : redacted;
}

export function readSmokeEvidenceOut(env) {
  const outRaw = readString(env.SMOKE_EVIDENCE_OUT);
  if (outRaw === undefined || outRaw.length === 0) {
    throw new Error("SMOKE_EVIDENCE_OUT is required");
  }
  return resolve(outRaw);
}

/** Ensure the CI artifact directory exists before hurl or shell poll can fail. */
export async function bootstrapSmokeEvidence(env) {
  const outRoot = readSmokeEvidenceOut(env);
  await mkdir(outRoot, { recursive: true });
  return outRoot;
}

function redactEntries(entries) {
  return entries.map((entry) => {
    const out = { ...entry };
    for (const key of ["text", "url", "error"]) {
      const text = readString(out[key]);
      if (text !== undefined) out[key] = redactDiagnosticText(text);
    }
    return out;
  });
}

/**
 * Minimal failure record when Playwright never created a page (hurl, poll, launch).
 */
export async function writeSmokePhaseFailure(env, phase, error, details = {}) {
  const outRoot = await bootstrapSmokeEvidence(env);
  const rawMessage =
    error instanceof Error
      ? error.message
      : String(error ?? "preview smoke failed");
  const message = redactDiagnosticText(rawMessage);
  const consoleEntries = Array.isArray(details.console)
    ? redactEntries(details.console)
    : [{ type: "phase", text: redactDiagnosticText(phase) }];
  const networkEntries = Array.isArray(details.network)
    ? redactEntries(details.network)
    : [];
  const body = (entries) =>
    `${JSON.stringify({ error: message, phase, entries }, null, 2)}\n`;
  await writeFile(join(outRoot, "failure-console.json"), body(consoleEntries));
  await writeFile(join(outRoot, "failure-network.json"), body(networkEntries));
  await writeFile(
    join(outRoot, "failure-summary.json"),
    `${JSON.stringify({ format: "cd-pwa-preview-smoke-failure", phase, error: message }, null, 2)}\n`,
  );
  return outRoot;
}
