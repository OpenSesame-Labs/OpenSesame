// Static checks for GitHub Actions workflow security. Hermetic: reads the
// checked-in YAML only. Used by workflow-security.test.mjs (npm run quality).
//
// What each check defends is recorded in docs/security/actions-security.md.
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { isJsonObject, isString } from "./json-boundary.mjs";

/**
 * Expression contexts an outsider can fill with arbitrary text. Interpolating
 * one into a shell or script body lets that text run as code; it must reach
 * the step through `env:` instead.
 */
const UNTRUSTED_CONTEXTS = [
  /github\.event\.(issue|pull_request|discussion)\.(title|body)\b/,
  /github\.event\.(comment|review|review_comment|discussion_comment)\.body\b/,
  /github\.event\.pages\b.*\.page_name\b/,
  /github\.event\.(commits\b.*|head_commit)\.(message|author\.(email|name))\b/,
  /github\.event\.pull_request\.head\.(ref|label|repo\.default_branch)\b/,
  /github\.event\.workflow_run\.(head_branch|display_title|head_commit\b|pull_requests\b)/,
  /github\.head_ref\b/,
  /github\.ref_name\b/,
  /(^|[^.\w])(github\.event\.)?inputs\./,
];

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/** Every `${{ }}` expression in `text` that reads an untrusted context. */
export function untrustedInterpolations(text) {
  const found = [];
  for (const match of String(text).matchAll(EXPRESSION)) {
    const expression = match[1].trim();
    if (UNTRUSTED_CONTEXTS.some((context) => context.test(expression)))
      found.push(expression);
  }
  return found;
}

function stepBodies(steps, where) {
  const bodies = [];
  for (const [index, step] of (steps ?? []).entries()) {
    const label = `${where} step ${step?.name ?? step?.id ?? index + 1}`;
    for (const text of [step?.run, step?.with?.script])
      if (isString(text)) bodies.push({ where: label, text });
  }
  return bodies;
}

/** Shell and script bodies of a workflow or composite action document. */
export function executableBodies(doc) {
  const bodies = stepBodies(doc?.runs?.steps, "action");
  for (const [id, job] of Object.entries(doc?.jobs ?? {}))
    bodies.push(...stepBodies(job?.steps, `job ${id}`));
  return bodies;
}

// YAML 1.1 parsers read a bare `on` key as boolean true; `yaml` keeps "on".
function triggerMap(doc) {
  const on = doc?.on ?? doc?.true;
  if (isString(on)) return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, null]));
  return on ?? {};
}

function triggerFindings(doc) {
  const findings = [];
  const triggers = triggerMap(doc);
  if ("pull_request_target" in triggers)
    findings.push("uses the privileged pull_request_target trigger");
  if ("workflow_run" in triggers && !triggers.workflow_run?.branches?.length)
    findings.push("workflow_run has no branches filter");
  return findings;
}

function permissionFindings(doc) {
  const findings = [];
  const top = doc?.permissions;
  if (!isJsonObject(top) || Object.keys(top).length > 0)
    findings.push("workflow-level permissions must be exactly {}");
  for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
    if (job?.permissions === undefined)
      findings.push(`job ${id} declares no permissions`);
    if (isString(job?.permissions))
      findings.push(`job ${id} uses the blanket ${job.permissions} grant`);
  }
  return findings;
}

function injectionFindings(doc) {
  const findings = [];
  for (const body of executableBodies(doc))
    for (const expression of untrustedInterpolations(body.text))
      findings.push(`${body.where} interpolates untrusted ${expression}`);
  return findings;
}

/** Findings for one workflow document; an empty list means it conforms. */
export function workflowFindings(doc) {
  return [
    ...triggerFindings(doc),
    ...permissionFindings(doc),
    ...injectionFindings(doc),
  ];
}

/** External `uses:` references that are not pinned to a full commit SHA. */
export function unpinnedUses(text) {
  const unpinned = [];
  for (const match of String(text).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    if (!/^[\w./-]+@[a-f0-9]{40}$/.test(reference)) unpinned.push(reference);
  }
  return unpinned;
}

/**
 * The full path of every external action or reusable workflow referenced,
 * without its ref: `owner/repo` or `owner/repo/subdirectory`.
 */
export function externalActionPaths(text) {
  const paths = new Set();
  for (const match of String(text).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (match[1].startsWith("./")) continue;
    paths.add(match[1].split("@")[0]);
  }
  return [...paths].sort();
}

function readIfPresent(url) {
  try {
    return readFileSync(url, "utf8");
  } catch {
    return undefined;
  }
}

/** Parsed workflow and composite-action files under `.github/`. */
export function loadActionsFiles(root) {
  const files = [];
  const workflows = new URL(".github/workflows/", root);
  for (const name of readdirSync(workflows).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(new URL(name, workflows), "utf8");
    files.push({ kind: "workflow", name, text, doc: parse(text) });
  }
  const actions = new URL(".github/actions/", root);
  for (const entry of readdirSync(actions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ["action.yml", "action.yaml"]) {
      const text = readIfPresent(new URL(`${entry.name}/${file}`, actions));
      if (text === undefined) continue;
      const name = `${entry.name}/${file}`;
      files.push({ kind: "action", name, text, doc: parse(text) });
    }
  }
  return files;
}
