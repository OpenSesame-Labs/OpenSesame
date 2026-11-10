import { execFileSync } from "node:child_process";
import { assertPrAgentAttribution } from "../lib/pr-agent-attribution.mjs";
import { loadPrIntroducedCommits } from "../lib/pr-introduced-commits.mjs";

const usage = "Usage: check-pr-grok-commits.mjs OWNER/REPO PR_NUMBER HEAD_SHA";

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(usage);
  process.exit(0);
}

const [repository, number, head] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !/^[1-9]\d*$/.test(number ?? "") ||
  !/^[a-f0-9]{40}$/.test(head ?? "")
) {
  throw new Error(usage);
}
function api(path, paginate = false) {
  return JSON.parse(
    execFileSync(
      "gh",
      ["api", path, ...(paginate ? ["--paginate", "--slurp"] : [])],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
const { pr, commits, baseRef } = loadPrIntroducedCommits(
  repository,
  number,
  head,
  api,
);
assertPrAgentAttribution(pr, commits, head);
console.log(
  `Agent attribution: ${commits.length} verified commit(s) on ${baseRef}...${head}`,
);
