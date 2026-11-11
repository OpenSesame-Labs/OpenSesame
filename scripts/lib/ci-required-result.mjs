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

/** A skipped job is acceptable only after a successful, explicit classification. */
export function assertSelectedResult({
  draft,
  preflight,
  selected,
  result,
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
    throw new Error(`selected suite: ${result}`);
  }
  if (selected === "false" && !["success", "skipped"].includes(result)) {
    throw new Error(`unselected suite: ${result}`);
  }
}

/** Qualification requires every declared dependency, including every matrix leg. */
export function assertCompleteResults(needs) {
  if (!isJsonObject(needs)) {
    throw new Error("invalid qualification dependencies");
  }
  const entries = Object.entries(needs);
  if (entries.length === 0) throw new Error("no qualification dependencies");
  for (const [name, value] of entries) {
    if (value?.result !== "success") {
      throw new Error(`${name}: ${value?.result ?? "missing"}`);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "all") {
      assertCompleteResults(JSON.parse(process.env.NEEDS_JSON ?? "null"));
    } else {
      assertSelectedResult({
        draft: process.env.DRAFT,
        preflight: process.env.PREFLIGHT_RESULT,
        selected: process.env.SELECTED,
        result: process.env.SUITE_RESULT,
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
