#!/usr/bin/env node
// Collects the engineering system metrics for this repository from the GitHub
// API and prints them as Markdown (stdout and the job summary).
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/name \
//     node scripts/metrics/engineering-system-metrics.mjs [--days N] [--out file.json]
//
// Read-only. A section the token cannot read is reported as unavailable; the
// run fails only when neither pull requests nor CI runs can be read at all.
// Definitions: docs/contributing/engineering-system-metrics.md
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  aiLeverage,
  ciMetrics,
  deliveryMetrics,
  deploymentState,
  openPullRequestMetrics,
  pullRequestMetrics,
  pulseMetrics,
  securityMetrics,
} from "../lib/engineering-metrics.mjs";
import { renderReport } from "../lib/engineering-metrics-report.mjs";

const root = new URL("../../", import.meta.url);
const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));
const config = readJson("tools/metrics/engineering-system.json");

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY ?? "";
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiUrl}/graphql`;

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function send(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "engineering-system-metrics",
      ...init.headers,
    },
  });
  // The status is the whole diagnosis. A response body is never echoed.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Pages through a REST list until it ends, `maxPages`, or `more` says stop. */
async function list(path, { maxPages = 10, pick = (json) => json, more } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const join = path.includes("?") ? "&" : "?";
    const url = `${apiUrl}/repos/${repository}${path}${join}per_page=100&page=${page}`;
    const batch = pick(await send(url));
    items.push(...batch);
    if (batch.length < 100) break;
    if (more && !more(batch.at(-1))) break;
  }
  return items;
}

async function attempt(collect) {
  try {
    return await collect();
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : "error" };
  }
}

const DEPLOYMENTS = `query($owner: String!, $name: String!, $environments: [String!], $cursor: String) {
  repository(owner: $owner, name: $name) {
    deployments(environments: $environments, first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { createdAt environment statuses(first: 30) { nodes { state } } }
    }
  }
}`;

async function productionDeployments(since) {
  const [owner, name] = repository.split("/");
  const found = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const variables = {
      owner,
      name,
      cursor,
      environments: config.productionEnvironments,
    };
    const result = await send(graphqlUrl, {
      method: "POST",
      body: JSON.stringify({ query: DEPLOYMENTS, variables }),
    });
    if (result.errors?.length) throw new Error("GraphQL error");
    const { nodes, pageInfo } = result.data.repository.deployments;
    const inWindow = nodes.filter((node) => node.createdAt >= since);
    for (const node of inWindow) {
      found.push({
        environment: node.environment,
        created_at: node.createdAt,
        state: deploymentState(
          node.statuses.nodes.map((status) => status.state),
        ),
      });
    }
    if (inWindow.length < nodes.length || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return found;
}

async function mergedPullRequests(since) {
  const closed = await list("/pulls?state=closed&sort=updated&direction=desc", {
    maxPages: 15,
    more: (last) => last.updated_at >= since,
  });
  return closed.filter((pull) => pull.merged_at && pull.merged_at >= since);
}

async function ciRuns(since) {
  const workflow = encodeURIComponent(config.ciWorkflow);
  const created = encodeURIComponent(`>=${since.slice(0, 10)}`);
  const runs = await list(
    `/actions/workflows/${workflow}/runs?event=${config.ciEvent}&status=completed&created=${created}`,
    {
      maxPages: Math.ceil(config.ciRunSample / 100),
      pick: (json) => json.workflow_runs,
    },
  );
  const jobsByRun = {};
  for (const run of runs.slice(0, config.ciJobSample)) {
    jobsByRun[run.id] = await list(`/actions/runs/${run.id}/jobs`, {
      maxPages: 2,
      pick: (json) => json.jobs,
    });
  }
  return ciMetrics(runs, jobsByRun);
}

async function pulse(since) {
  const label = encodeURIComponent(config.pulseLabel);
  const issues = await list(
    `/issues?labels=${label}&state=all&since=${since}`,
    {
      maxPages: 3,
    },
  );
  return pulseMetrics(
    issues.filter((issue) => !issue.pull_request && issue.created_at >= since),
  );
}

async function collect(days) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000).toISOString();
  const now = until.toISOString();
  const deployments = await attempt(() => productionDeployments(since));
  const known = Array.isArray(deployments) ? deployments : [];
  return {
    generatedAt: now,
    repository,
    window: { since, until: now, days },
    productionEnvironments: config.productionEnvironments,
    staleDays: config.stalePullRequestDays,
    delivery: Array.isArray(deployments)
      ? deliveryMetrics(deployments, days)
      : deployments,
    pulls: await attempt(async () =>
      pullRequestMetrics(await mergedPullRequests(since), known),
    ),
    open: await attempt(async () =>
      openPullRequestMetrics(
        await list("/pulls?state=open", { maxPages: 3 }),
        now,
        config.stalePullRequestDays,
      ),
    ),
    ci: await attempt(() => ciRuns(since)),
    leverage: await attempt(async () =>
      aiLeverage(await list(`/commits?since=${since}`, { maxPages: 15 })),
    ),
    security: await attempt(async () =>
      securityMetrics(
        await list("/code-scanning/alerts?state=open", { maxPages: 10 }),
        now,
      ),
    ),
    maintainability: readJson("tools/quality/quality-baseline.json").totals,
    pulse: await attempt(() => pulse(since)),
    business: config.business,
  };
}

async function main() {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    console.error(
      "Set GH_TOKEN (or GITHUB_TOKEN) and GITHUB_REPOSITORY=owner/name.",
    );
    process.exit(2);
  }
  const days = Number(option("--days") ?? config.windowDays);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    console.error("--days must be a whole number from 1 to 366.");
    process.exit(2);
  }
  const report = await collect(days);
  const markdown = renderReport(report);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  const out = option("--out");
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const stale = report.open?.stale?.length ?? 0;
  if (stale > 0)
    console.log(
      `::warning title=Pull requests waiting::${stale} open pull request(s) are older than ${config.stalePullRequestDays} days.`,
    );
  if (report.pulls.unavailable && report.ci.unavailable) {
    console.error("Neither pull requests nor CI runs could be read.");
    process.exit(1);
  }
}

await main();
