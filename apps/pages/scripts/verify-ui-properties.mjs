import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import {
  checkExploration,
  switchCoverage,
  tabsCoverage,
} from "./lib/ui-property-trace.mjs";

const pages = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pages, "test/ui-properties/fixture");
const targets = [
  {
    name: "connector-modes",
    path: "/",
    spec: join(pages, "test/ui-properties/connector-modes.ts"),
    mutantViolation: "named_group_has_one_matching_selection",
  },
  {
    name: "capability-switch",
    path: "/switch.html",
    spec: join(pages, "test/ui-properties/capability-switch.ts"),
    mutantViolation: "switch_requests_match_attempts",
  },
  {
    name: "roving-tabs",
    path: "/tabs.html",
    spec: join(pages, "test/ui-properties/roving-tabs.ts"),
    mutantViolation: "tabs_follow_intent",
  },
];
const bombadil = resolve(
  pages,
  "../../node_modules/@antithesishq/bombadil/bin/bombadil.js",
);
const output = await mkdtemp(join(tmpdir(), "opensesame-bombadil-"));
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});

function argumentsFor(target, width, mutant, url, trace) {
  const args = [
    bombadil,
    "browser",
    "test",
    "--headless",
    "--width",
    String(width),
    "--height",
    "800",
    "--output-path",
    trace,
  ];
  const replay = process.env.BOMBADIL_REPRODUCE;
  if (replay && !mutant) args.push("--reproduce", resolve(replay));
  else
    args.push(
      "--exit-on-violation",
      "--time-limit",
      process.env.BOMBADIL_TIME_LIMIT ?? "20s",
    );
  if (process.env.BOMBADIL_NO_SANDBOX === "1") args.push("--no-sandbox");
  args.push(url, target.spec);
  return args;
}

async function explore(args, mutantViolation) {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let sawClick = false;
  let sawViolation = false;
  for (const [stream, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let tail = "";
    stream.on("data", (chunk) => {
      const text = tail + chunk.toString();
      sawClick ||= text.includes("Clicking");
      sawViolation ||= text.includes(`${mutantViolation} was violated`);
      tail = text.slice(-100);
      destination.write(chunk);
    });
  }
  const code = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (status, signal) => done(status ?? (signal ? 1 : 0)));
  });
  return { code, sawClick, sawViolation };
}

async function run(target, width, mutant = false) {
  const origin = server.resolvedUrls?.local[0];
  if (!origin) throw new Error("No fixture origin");
  const url = new URL(target.path, origin);
  if (mutant) url.searchParams.set("mutant", "1");
  const trace = join(
    output,
    target.name,
    mutant ? `mutant-${width}` : String(width),
  );
  console.log(
    `Bombadil target ${target.name} at ${width}px${mutant ? " (self-check)" : ""}`,
  );
  const result = await explore(
    argumentsFor(target, width, mutant, url.href, trace),
    target.mutantViolation,
  );
  checkExploration(result, target.name, width, mutant);
  if (
    !mutant &&
    target.name === "capability-switch" &&
    !process.env.BOMBADIL_REPRODUCE
  ) {
    const coverage = switchCoverage(
      await readFile(join(trace, "trace.jsonl"), "utf8"),
    );
    console.log(`Switch attempts: ${JSON.stringify(coverage)}`);
  }
  if (
    !mutant &&
    target.name === "roving-tabs" &&
    !process.env.BOMBADIL_REPRODUCE
  ) {
    const coverage = tabsCoverage(
      await readFile(join(trace, "trace.jsonl"), "utf8"),
    );
    console.log(`Tab keyboard actions: ${JSON.stringify(coverage)}`);
  }
}

try {
  await server.listen();
  const requested = process.env.BOMBADIL_TARGET;
  const chosen = requested
    ? targets.filter((target) => target.name === requested)
    : targets;
  if (chosen.length === 0)
    throw new Error(`Unknown Bombadil target: ${requested}`);
  if (process.argv.includes("--self-check")) {
    if (process.env.BOMBADIL_REPRODUCE)
      throw new Error("Cannot replay a self-check");
    for (const target of chosen) {
      for (const width of [390, 1365]) await run(target, width, true);
    }
  } else if (process.env.BOMBADIL_REPRODUCE) {
    const width = Number(process.env.BOMBADIL_WIDTH ?? 390);
    if (!Number.isSafeInteger(width) || width < 1)
      throw new Error("Invalid replay width");
    // Preserve the original connector-only replay default.
    await run(chosen[0], width);
  } else {
    for (const target of chosen) {
      for (const width of [390, 1365]) await run(target, width);
    }
  }
  console.log(`Bombadil traces: ${output}`);
} finally {
  await server.close();
}
