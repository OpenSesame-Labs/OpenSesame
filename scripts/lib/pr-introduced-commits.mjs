/**
 * Commits a PR would introduce on its base branch — not pulls/{n}/commits,
 * which can list main commits when the recorded base SHA is stale.
 */

/** @typedef {(path: string, paginate?: boolean) => unknown} GithubApi */

/**
 * @param {string} repository `OWNER/REPO`
 * @param {number | string} prNumber
 * @param {string} expectedHead 40-hex
 * @param {GithubApi} api `gh api` caller; paginate uses --paginate --slurp
 */
export function loadPrIntroducedCommits(repository, prNumber, expectedHead, api) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`invalid repository: ${repository}`);
  }
  if (!/^[1-9]\d*$/.test(String(prNumber))) {
    throw new Error(`invalid PR number: ${prNumber}`);
  }
  if (!/^[a-f0-9]{40}$/.test(expectedHead)) {
    throw new Error("expectedHead must be a 40-character commit SHA");
  }

  const endpoint = `repos/${repository}/pulls/${prNumber}`;
  const pr = /** @type {{ head?: { sha?: string }; base?: { ref?: string; sha?: string } }} */ (
    api(endpoint)
  );
  if (pr.head?.sha !== expectedHead) {
    throw new Error("PR head changed; rerun CI on the current head");
  }
  const baseRef = pr.base?.ref;
  if (baseRef === undefined || baseRef === "") {
    throw new Error("PR base ref missing; cannot compute introduced commits");
  }

  const comparePath = `repos/${repository}/compare/${encodeURIComponent(baseRef)}...${expectedHead}`;
  const pages = /** @type {Array<{ commits?: Array<{ sha: string }>; total_commits?: number }>} */ (
    api(`${comparePath}?per_page=100`, true)
  );
  const commits = pages.flatMap((page) => page.commits ?? []);
  const totalCommits = pages[0]?.total_commits;
  if (totalCommits !== undefined && commits.length !== totalCommits) {
    throw new Error(
      "Incomplete introduced-commit inventory from compare API; refusing check",
    );
  }
  return { pr, commits, baseRef };
}
