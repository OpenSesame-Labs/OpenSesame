#!/usr/bin/env node
/** Compose unmodified browser captures from the two real build outputs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.env.EVIDENCE_ROOT;
const before = process.env.EVIDENCE_BASE_SHA;
const after = process.env.EVIDENCE_HEAD_SHA;
assert(/^[a-f0-9]{40}$/.test(before));
assert(/^[a-f0-9]{40}$/.test(after));
const browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM, args: process.env.PLAYWRIGHT_NO_SANDBOX ? ["--no-sandbox", "--disable-dev-shm-usage"] : []});
const manifest = {base: before, head: after, frames: [], measurements: {}};
const sheetDir = path.join(root, "comparisons");
fs.mkdirSync(sheetDir, {recursive: true});
try {
  for (const theme of (process.env.EVIDENCE_THEMES ?? "light,dark").split(",")) {
    for (const side of ["before", "after"]) {
      manifest.measurements[`${side}-${theme}`] = JSON.parse(
        fs.readFileSync(path.join(root, side, theme, "measurements.json"), "utf8"),
      );
    }
    for (const width of (process.env.EVIDENCE_WIDTHS ?? "320,390,1280").split(",").map(Number)) {
      for (const frame of ["guest-detail", "guest-editor", "rotation-error", "rotation-failure", "rotation-after-lock"]) {
        const parts = frame.split("-");
        const file = `${parts[0]}-${width}-${parts.slice(1).join("-")}.png`;
        const png = (side) => fs.readFileSync(path.join(root, side, theme, file)).toString("base64");
        const context = await browser.newContext({viewport: {width: 2 * width + 48, height: (width === 320 ? 568 : width === 390 ? 844 : 900) + 72}, deviceScaleFactor: 1});
        const page = await context.newPage();
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f5f5f5;color:#111;font:16px sans-serif}.title{padding:12px}.pair{display:flex;gap:16px;padding:0 16px 16px}.item{width:${width}px}.label{margin-bottom:8px;font-weight:600}.item img{display:block;width:${width}px;height:auto}</style><div class="title">${frame} · ${width}px · ${theme}</div><div class="pair"><div class="item"><div class="label">Before · ${before.slice(0, 12)}</div><img src="data:image/png;base64,${png("before")}"></div><div class="item"><div class="label">After · ${after.slice(0, 12)}</div><img src="data:image/png;base64,${png("after")}"></div></div>`);
        const output = `${theme}-${width}-${frame}.png`;
        await page.screenshot({path: path.join(sheetDir, output), fullPage: true, animations: "disabled"});
        manifest.frames.push({theme, width, frame, before: `before/${theme}/${file}`, after: `after/${theme}/${file}`, comparison: `comparisons/${output}`});
        await context.close();
      }
    }
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
} finally {
  await browser.close();
}
