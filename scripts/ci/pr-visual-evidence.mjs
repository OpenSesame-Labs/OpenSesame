/** Generate only synthetic before/after PR review sheets, never approved evidence. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const review = path.join(root, "work/evidence/pr-visual");
const artifact = path.join(review, "artifact");
const capture = path.join(root, "apps/pages/scripts/capture-evidence.mjs");
const versionFixture = "work/evidence/pr-visual/unsupported-version.kdbx";

function screen(width, height, steps) {
  return { ...(width > 600 ? { desktop: true } : {}), width, height, steps };
}

function clipboardSteps(shot) {
  return [
    { guest: null },
    { tab: "Settings" },
    { open: "General" },
    { press: "Not now" },
    { scrollTo: "Locking" },
    { measure: "#settings-clipboard" },
    { measure: "#settings-locking .field__help" },
    { shot },
  ];
}

function kdbxSteps(shot) {
  return [
    { guest: null },
    { setFile: { label: "Choose a file to import", file: versionFixture } },
    { fill: { label: "Master password", text: "test" } },
    { press: "Open database" },
    { tap: ".f__labelrow .status-mark--err" },
    { measure: ".status-bubble" },
    { shot },
  ];
}

function journey(kind) {
  const isClipboard = kind === "clipboard";
  const steps = isClipboard ? clipboardSteps : kdbxSteps;
  const prefix = isClipboard ? "clipboard" : "kdbx-error";
  return {
    out: ".",
    screens: [
      screen(390, 844, steps(`${prefix}-phone`)),
      screen(1280, 900, steps(`${prefix}-desktop`)),
    ],
    sheets: [
      { shot: `${prefix}-phone`, width: 390, title: `${kind} — phone` },
      { shot: `${prefix}-desktop`, width: 1280, title: `${kind} — desktop` },
    ],
  };
}

function run(label, journeyPath, dist) {
  const result = spawnSync(
    process.execPath,
    [capture, "capture", label, journeyPath],
    {
      cwd: root,
      env: { ...process.env, EVIDENCE_DIST: dist, VITE_BASE: "/OpenSesame/" },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 240_000,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `capture ${label} failed: ${result.error ?? result.stderr}`,
    );
  return result.stdout;
}

/** Only numeric browser measurements enter captions; page text is never interpolated. */
export function measurements(output, selectors) {
  const rows = output
    .split("\n")
    .filter((line) => line.startsWith("  measure "));
  if (rows.length !== selectors.length * 2)
    throw new Error("unexpected measurement count");
  return rows.map((line, index) => {
    const prefix = `  measure ${selectors[index % selectors.length]}: `;
    if (!line.startsWith(prefix))
      throw new Error("unexpected measurement selector");
    const value = line.slice(prefix.length);
    if (
      value === "none" &&
      selectors[index % selectors.length] !== "#settings-locking .field__help"
    )
      throw new Error("required measured element is missing");
    if (
      !/^(?:none|\d+x\d+ @-?\d+,-?\d+(?: \| \d+x\d+ @-?\d+,-?\d+)*)$/u.test(
        value,
      )
    )
      throw new Error("invalid browser measurement");
    return value;
  });
}

function compose(journeyPath) {
  const result = spawnSync(
    process.execPath,
    [capture, "compose", journeyPath],
    {
      cwd: root,
      env: { ...process.env, VITE_BASE: "/OpenSesame/" },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (result.status !== 0)
    throw new Error(`compose failed: ${result.error ?? result.stderr}`);
}

function assertSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? ""))
    throw new Error("expected a full Git SHA");
  return value;
}

export function captureReview({ base, head, baseDist, headDist }) {
  assertSha(base);
  assertSha(head);
  if (!path.isAbsolute(baseDist) || !path.isAbsolute(headDist))
    throw new Error("absolute dist paths required");
  mkdirSync(artifact, { recursive: true });
  writeFileSync(
    path.join(root, versionFixture),
    Buffer.from("03d9a29a67fb4bb500000500", "hex"),
  );
  const records = {};
  const observed = {};
  for (const kind of ["clipboard", "kdbx"]) {
    const dir = path.join(review, kind);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "journey.json");
    const spec = journey(kind);
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    const selectors =
      kind === "clipboard"
        ? ["#settings-clipboard", "#settings-locking .field__help"]
        : [".status-bubble"];
    const before = measurements(run("before", file, baseDist), selectors);
    const after = measurements(run("after", file, headDist), selectors);
    observed[kind] = { selectors, before, after };
    const width = selectors.length;
    for (const [index, sheet] of spec.sheets.entries()) {
      const offset = index * width;
      sheet.caption = `Synthetic journey; base ${base.slice(0, 12)}, head ${head.slice(0, 12)}.`;
      sheet.before = before.slice(offset, offset + width).join("; ");
      sheet.after = after.slice(offset, offset + width).join("; ");
    }
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    compose(file);
    for (const { shot } of spec.sheets) {
      const name = `${shot}.png`;
      const content = readFileSync(path.join(dir, name));
      copyFileSync(path.join(dir, name), path.join(artifact, name));
      records[name] = createHash("sha256").update(content).digest("hex");
    }
  }
  const receipt = {
    version: 1,
    base,
    head,
    profile: "full",
    measurements: observed,
    screenshots: records,
  };
  writeFileSync(
    path.join(artifact, "manifest.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  captureReview({
    base: process.env.PR_VISUAL_BASE_SHA,
    head: process.env.PR_VISUAL_HEAD_SHA,
    baseDist: process.env.PR_VISUAL_BASE_DIST,
    headDist: process.env.PR_VISUAL_HEAD_DIST,
  });
}
