#!/usr/bin/env node
/**
 * Render a statechart .mmd with Pele (pele@1.9.0) and OpenSesame theme.
 * Use after /statechart writes chart.mmd. Does not copy statechart paths into output.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  bakeOpenSesameTheme,
  stripMermaidMarks,
} from "./pele-theme-tokens.mjs";

const require = createRequire(import.meta.url);

const PELE_OPTS = {
  limit: 1_000_000,
  outputLimit: 8_000_000,
  maxEdges: 10_000,
};

function usage() {
  console.error(`Usage: node render-pele-chart.mjs --mmd FILE [--out DIR] [--mode light|dark|both] [--png]
  --strip-legend   drop statechart Legend subgraph (default: on)
  --no-theme       default Pele colors (before comparison only)
  --pixel-diff     write pixel-diff.json when generating default+themed PNGs`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    mmd: null,
    outDir: null,
    mode: "both",
    png: false,
    stripLegend: true,
    theme: true,
    pixelDiff: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mmd") out.mmd = argv[++i];
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--png") out.png = true;
    else if (a === "--strip-legend") out.stripLegend = true;
    else if (a === "--no-strip-legend") out.stripLegend = false;
    else if (a === "--no-theme") out.theme = false;
    else if (a === "--pixel-diff") out.pixelDiff = true;
    else usage();
  }
  if (!out.mmd) usage();
  if (!out.outDir) out.outDir = dirname(resolve(out.mmd));
  return out;
}

/** Remove statechart Legend explainer subgraph and its class lines. */
export function stripChartLegend(mmd) {
  let text = mmd.replace(/\r\n/g, "\n");
  text = text.replace(
    /^[ \t]*state "Legend" as legend \{[\s\S]*?\n[ \t]*\}\n?/m,
    "",
  );
  text = text.replace(/^[ \t]*class[ \t]+lg\d+[^\n]*\n?/gm, "");
  return text;
}

function renderOne(pele, mmd, { theme, mode }) {
  const raw = pele.render(mmd, PELE_OPTS);
  const svg = raw.svg ?? raw;
  if (!theme) return svg;
  return bakeOpenSesameTheme(svg, mode);
}

async function writePng(svgPath, pngPath) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "npx",
    ["--yes", "@resvg/resvg-js-cli", svgPath, pngPath],
    { stdio: "pipe" },
  );
}

async function writePixelDiff(outDir, base) {
  const { PNG } = require("pngjs");
  const load = (p) => PNG.sync.read(readFileSync(p));
  const diff = (a, b) => {
    let n = 0;
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const ia = (a.width * y + x) << 2;
        const ib = (b.width * y + x) << 2;
        let changed = false;
        for (let c = 0; c < 3; c++)
          if (Math.abs(a.data[ia + c] - b.data[ib + c]) > 2) changed = true;
        if (changed) n++;
      }
    return { diffPixels: n, total: w * h, width: w, height: h };
  };
  const dir = outDir;
  const def = load(join(dir, `${base}.default.png`));
  const light = load(join(dir, `${base}.light.png`));
  const dark = load(join(dir, `${base}.dark.png`));
  const report = {
    defaultVsLight: diff(def, light),
    defaultVsDark: diff(def, dark),
    lightVsDark: diff(light, dark),
  };
  writeFileSync(join(dir, "pixel-diff.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  let pele;
  try {
    pele = require("pele");
  } catch {
    console.error(
      "Install pele@1.9.0 outside the repo (e.g. npm install pele@1.9.0 in a scratch dir) and set NODE_PATH.",
    );
    process.exit(1);
  }

  mkdirSync(args.outDir, { recursive: true });
  let mmd = readFileSync(resolve(args.mmd), "utf8");
  if (args.stripLegend) mmd = stripChartLegend(mmd);
  if (args.theme) mmd = stripMermaidMarks(mmd);

  const base = resolve(args.mmd).replace(/\.mmd$/i, "").split("/").pop();

  const modes =
    args.mode === "both" ? ["light", "dark"] : [args.mode === "dark" ? "dark" : "light"];

  for (const mode of modes) {
    const svgPath = join(args.outDir, `${base}.${mode}.svg`);
    const svg = renderOne(pele, mmd, { theme: args.theme, mode });
    writeFileSync(svgPath, svg);
    if (args.png) {
      await writePng(svgPath, svgPath.replace(/\.svg$/, ".png"));
    }
  }

  if (args.theme && args.mode === "both") {
    const defPath = join(args.outDir, `${base}.default.svg`);
    const defSvg = renderOne(pele, mmd, { theme: false, mode: "light" });
    writeFileSync(defPath, defSvg);
    if (args.png) {
      await writePng(defPath, defPath.replace(/\.svg$/, ".png"));
      if (args.pixelDiff) await writePixelDiff(args.outDir, base);
    }
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}