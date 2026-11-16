import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const pages = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pages, "test/ui-properties/fixture");
const spec = join(pages, "test/ui-properties/connector-modes.ts");
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

function argumentsFor(width, mutant, url) {
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
    join(output, mutant ? "mutant" : String(width)),
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
  args.push(url, spec);
  return args;
}

async function explore(args) {
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
      sawViolation ||= text.includes(
        "named_group_has_one_matching_selection was violated",
      );
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

async function run(width, mutant = false) {
  const origin = server.resolvedUrls?.local[0];
  if (!origin) throw new Error("No fixture origin");
  const url = new URL(mutant ? "?mutant=1" : "", origin).href;
  const { code, sawClick, sawViolation } = await explore(
    argumentsFor(width, mutant, url),
  );
  if (mutant) {
    if (code === 0 || !sawViolation)
      throw new Error("The deliberate mutation was not detected");
  } else if (code !== 0 || !sawClick) {
    throw new Error(`Bombadil failed at ${width}px`);
  }
}

try {
  await server.listen();
  if (process.argv.includes("--self-check")) await run(390, true);
  else if (process.env.BOMBADIL_REPRODUCE)
    await run(Number(process.env.BOMBADIL_WIDTH ?? 390));
  else {
    await run(390);
    await run(1365);
  }
  console.log(`Bombadil traces: ${output}`);
} finally {
  await server.close();
}
