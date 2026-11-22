import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "./json-boundary.mjs";

const SHA = /^[0-9a-f]{40}$/;

/**
 * Whether a newer push replaced the commit a pull request run was started
 * for. Only pull request runs are cancelled by concurrency, so no other event
 * can be superseded. `lookup` returns the pull request's current head.
 */
export function superseded({ event, runHead, pull }, lookup) {
  if (event !== "pull_request") return false;
  if (!SHA.test(runHead ?? "") || !/^[1-9]\d*$/.test(pull ?? "")) return false;
  try {
    const head = lookup(pull);
    return SHA.test(head ?? "") && head !== runHead;
  } catch {
    // Not knowing is not the same as superseded.
    return false;
  }
}

/** The current head of a pull request, read from the remote without a token. */
function pullHead(pull) {
  const remote = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  const listed = execFileSync(
    "git",
    ["ls-remote", remote, `refs/pull/${pull}/head`],
    { encoding: "utf8", timeout: 30_000 },
  );
  return listed.split(/\s/)[0];
}

/**
 * Results that mean the upstream job never ran to completion in this attempt.
 * A partial re-run ("Re-run failed jobs" or re-running only a reporter) leaves
 * upstream jobs out of the attempt, and GitHub reports them as `abandoned`.
 */
const NOT_RUN = new Set(["abandoned", "cancelled", "skipped", "missing", ""]);

/** Operator guidance appended whenever required upstream work did not run. */
export const RERUN_ALL_HINT =
  "a partial re-run of reporter jobs cannot turn a selected suite green; " +
  'use "Re-run all jobs" (or push a new commit) so the upstream builds run ' +
  "in the same attempt";

function attemptNote(attempt) {
  return /^[1-9]\d*$/.test(attempt ?? "") && attempt !== "1"
    ? ` in run attempt ${attempt}`
    : "";
}

/** A skipped job is acceptable only after a successful, explicit classification. */
export function assertSelectedResult({
  draft,
  preflight,
  selected,
  result,
  suite = "suite",
  attempt,
  replaced = false,
}) {
  // Concurrency cancels an in-flight pull request run after a newer push. That
  // run admitted nothing and is not reported failed. A run cancelled any other
  // way never classified its change, so it must not read as a passing build.
  if (preflight === "cancelled") {
    if (replaced) return;
    throw new Error("preflight: cancelled, and no newer push replaced the run");
  }
  if (draft !== "false") throw new Error("draft or missing draft admission");
  if (preflight !== "success") throw new Error(`preflight: ${preflight}`);
  if (!["true", "false"].includes(selected)) {
    throw new Error("missing or invalid area classification");
  }
  if (selected === "true" && result !== "success") {
    // Never accept a job that did not run, on any attempt: a reporter re-run
    // without its upstream build is not evidence that the build passed.
    const shown = result || "missing";
    const message = `selected suite ${suite}: ${shown}${attemptNote(attempt)}`;
    throw new Error(
      NOT_RUN.has(shown)
        ? `${message}; upstream job not run: ${suite} (${shown}); ${RERUN_ALL_HINT}`
        : message,
    );
  }
  if (selected === "false" && !["success", "skipped"].includes(result)) {
    throw new Error(`unselected suite: ${result}`);
  }
}

/** Qualification requires every declared dependency, including every matrix leg. */
export function assertCompleteResults(needs, attempt) {
  if (!isJsonObject(needs)) {
    throw new Error("invalid qualification dependencies");
  }
  const entries = Object.entries(needs);
  if (entries.length === 0) throw new Error("no qualification dependencies");
  const failed = entries
    .map(([name, value]) => [name, value?.result || "missing"])
    .filter(([, result]) => result !== "success");
  if (failed.length === 0) return;
  const listed = failed.map(([name, result]) => `${name}: ${result}`);
  const notRun = failed.filter(([, result]) => NOT_RUN.has(result));
  let message = `${listed.join(", ")}${attemptNote(attempt)}`;
  if (notRun.length > 0) {
    const names = notRun.map(([name, result]) => `${name} (${result})`);
    message += `; upstream jobs not run: ${names.join(", ")}; ${RERUN_ALL_HINT}`;
  }
  throw new Error(message);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "all") {
      assertCompleteResults(
        JSON.parse(process.env.NEEDS_JSON ?? "null"),
        process.env.GITHUB_RUN_ATTEMPT,
      );
    } else {
      assertSelectedResult({
        draft: process.env.DRAFT,
        preflight: process.env.PREFLIGHT_RESULT,
        selected: process.env.SELECTED,
        result: process.env.SUITE_RESULT,
        suite: process.env.SUITE_JOB || "suite",
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        replaced:
          process.env.PREFLIGHT_RESULT === "cancelled" &&
          superseded(
            {
              event: process.env.GITHUB_EVENT_NAME,
              runHead: process.env.RUN_HEAD_SHA,
              pull: process.env.PULL_NUMBER,
            },
            pullHead,
          ),
      });
    }
  } catch (error) {
    console.error(`CI required result: ${error.message}`);
    process.exitCode = 1;
  }
}
