/** Resolve an explicit PR only while its base is the trusted workflow commit. */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function validateContext({ repository, defaultBranch, number, controlSha }) {
  if (
    !/^[1-9][0-9]{0,6}$/u.test(number ?? "") ||
    !/^[A-Za-z0-9_.-]+$/u.test(defaultBranch ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !/^[0-9a-f]{40}$/u.test(controlSha ?? "")
  )
    throw new Error("invalid PR evidence request");
}

function validatePullIdentity(pull, { defaultBranch, number }) {
  if (
    pull?.state !== "open" ||
    pull?.number !== Number(number) ||
    pull?.base?.ref !== defaultBranch
  )
    throw new Error("PR is not an open default-branch comparison");
}

function validatePullRepositories(pull, { repository }) {
  if (
    pull?.base?.repo?.full_name !== repository ||
    pull?.head?.repo?.full_name !== repository
  )
    throw new Error("PR is not a same-repository comparison");
}

export function selectPr(pull, branch, context) {
  validateContext(context);
  validatePullIdentity(pull, context);
  validatePullRepositories(pull, context);
  const base = pull?.base?.sha;
  const head = pull?.head?.sha;
  if (
    !/^[0-9a-f]{40}$/u.test(head ?? "") ||
    base !== context.controlSha ||
    branch?.object?.sha !== context.controlSha ||
    (context.expectedHead !== undefined && head !== context.expectedHead)
  )
    throw new Error("PR revisions changed during evidence capture");
  return { base, head };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [pullFile, branchFile] = process.argv.slice(2);
  const result = selectPr(
    JSON.parse(readFileSync(pullFile, "utf8")),
    JSON.parse(readFileSync(branchFile, "utf8")),
    {
      repository: process.env.GITHUB_REPOSITORY,
      defaultBranch: process.env.PR_VISUAL_DEFAULT_BRANCH,
      number: process.env.PR_VISUAL_NUMBER,
      controlSha: process.env.GITHUB_SHA,
      expectedHead: process.env.PR_VISUAL_EXPECTED_HEAD || undefined,
    },
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `base_sha=${result.base}\nhead_sha=${result.head}\n`,
  );
}
