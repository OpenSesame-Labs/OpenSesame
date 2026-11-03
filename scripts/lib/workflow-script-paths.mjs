/**
 * Guard: every `node scripts/…` referenced in a workflow job must exist on disk
 * and appear in that job's sparse-checkout list when sparse checkout is used.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NODE_RE = /\bnode scripts\/([^\s'"${}\\]+\.mjs)/g;

export function scriptPathsInText(text) {
  const paths = new Set();
  for (const match of text.matchAll(SCRIPT_NODE_RE)) {
    paths.add(`scripts/${match[1].replace(/^\.\//, "")}`);
  }
  return [...paths];
}

/** Whether a repo path is included by GitHub sparse-checkout cone patterns. */
export function pathCoveredBySparseCheckout(filePath, patterns) {
  if (patterns.length === 0) {
    return true;
  }
  const normalized = filePath.replace(/^\.\//, "").replaceAll("\\", "/");
  for (const raw of patterns) {
    const pattern = raw.trim().replaceAll("\\", "/");
    if (pattern.length === 0) continue;
    if (normalized === pattern) {
      return true;
    }
    if (normalized.startsWith(`${pattern}/`)) {
      return true;
    }
    if (pattern.endsWith("/") && normalized.startsWith(pattern)) {
      return true;
    }
  }
  return false;
}

function jobBlocks(jobsSection) {
  const blocks = [];
  const lines = jobsSection.split("\n");
  let current = null;
  for (const line of lines) {
    const start = /^ {2}([a-z][a-z0-9_]*):\s*$/.exec(line);
    if (start) {
      if (current) blocks.push(current);
      current = { id: start[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

function sparsePatterns(jobLines) {
  const patterns = [];
  let collecting = false;
  for (const line of jobLines) {
    if (/^\s+sparse-checkout:\s*\|/.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting) {
      const entry = /^(\s{10,})(\S.*)$/.exec(line);
      if (entry) {
        patterns.push(entry[2].trim());
        continue;
      }
      collecting = false;
    }
  }
  return patterns;
}

export function analyzeWorkflow(
  content,
  { workflowPath = "workflow.yml" } = {},
) {
  const jobsIndex = content.indexOf("\njobs:\n");
  if (jobsIndex === -1) {
    return [];
  }
  const jobsSection = content.slice(jobsIndex + "\njobs:\n".length);
  const findings = [];
  for (const block of jobBlocks(jobsSection)) {
    const text = block.lines.join("\n");
    const sparse = sparsePatterns(block.lines);
    const scripts = scriptPathsInText(text);
    for (const script of scripts) {
      findings.push({
        workflowPath,
        jobId: block.id,
        script,
        sparse,
      });
    }
  }
  return findings;
}

export function assertWorkflowScriptPaths(root, workflowRelPath) {
  const content = readFileSync(join(root, workflowRelPath), "utf8");
  const issues = [];
  for (const entry of analyzeWorkflow(content, {
    workflowPath: workflowRelPath,
  })) {
    if (entry.sparse.length === 0) {
      continue;
    }
    const diskPath = join(root, entry.script);
    if (!existsSync(diskPath)) {
      issues.push(
        `${workflowRelPath} job ${entry.jobId}: missing file ${entry.script}`,
      );
      continue;
    }
    if (!pathCoveredBySparseCheckout(entry.script, entry.sparse)) {
      issues.push(
        `${workflowRelPath} job ${entry.jobId}: ${entry.script} not in sparse-checkout (${entry.sparse.join(", ") || "none"})`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
}

/** Workflows whose sparse-checkout jobs must include every `node scripts/…` they run. */
export const SPARSE_SCRIPT_GUARD_WORKFLOWS = Object.freeze([
  ".github/workflows/cd-npm-cli.yml",
  ".github/workflows/cd-npm-publish-proof.yml",
  ".github/workflows/cd-promotion-gates-proof.yml",
  ".github/workflows/cd-pwa.yml",
]);

export function listWorkflowFiles(root) {
  const dir = join(root, ".github/workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `.github/workflows/${name}`);
}

export function repoRootFromHere() {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}
