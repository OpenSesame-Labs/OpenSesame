/** Fail closed on build output or review artifacts that could escape the sandbox. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const expected = [
  "clipboard-desktop.png",
  "clipboard-phone.png",
  "kdbx-error-desktop.png",
  "kdbx-error-phone.png",
];

function directory(root) {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("expected an owned directory");
}

/** Scan without following symlinks; reject links, special files and oversized output. */
export function validateDist(root) {
  directory(root);
  const pending = [root];
  let files = 0;
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const file = path.join(current, entry);
      entries += 1;
      if (entries > 20_000 || path.relative(root, file).length > 1024)
        throw new Error("dist exceeds the review budget");
      const info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error("dist contains a symlink");
      if (info.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("dist contains a non-regular or linked file");
      files += 1;
      bytes += info.size;
      if (
        files > 15_000 ||
        info.size > 64 * 1024 * 1024 ||
        bytes > 256 * 1024 * 1024
      )
        throw new Error("dist exceeds the review budget");
    }
  }
  if (files === 0 || !lstatSync(path.join(root, "index.html")).isFile())
    throw new Error("dist has no index");
  return { files, bytes };
}

function validateNames(root) {
  directory(root);
  const names = readdirSync(root).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify([...expected, "manifest.json"].sort())
  )
    throw new Error("unexpected review artifacts");
  for (const name of names) {
    const info = lstatSync(path.join(root, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > (name === "manifest.json" ? 65_536 : 2 * 1024 * 1024)
    )
      throw new Error("review artifact is linked, invalid or oversized");
  }
}

function validateReceipt(receipt, base, head) {
  if (
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify([
        "base",
        "head",
        "measurements",
        "profile",
        "screenshots",
        "version",
      ]) ||
    receipt.version !== 1 ||
    receipt.base !== base ||
    receipt.head !== head ||
    receipt.profile !== "full" ||
    !/^[0-9a-f]{40}$/u.test(base) ||
    !/^[0-9a-f]{40}$/u.test(head) ||
    JSON.stringify(Object.keys(receipt.screenshots ?? {}).sort()) !==
      JSON.stringify(expected)
  )
    throw new Error("review artifact provenance mismatch");
}

function validateMeasurements(receipt) {
  const kinds = {
    clipboard: ["#settings-clipboard", "#settings-locking .field__help"],
    kdbx: [".status-bubble"],
  };
  if (
    JSON.stringify(Object.keys(receipt.measurements ?? {}).sort()) !==
    JSON.stringify(Object.keys(kinds).sort())
  )
    throw new Error("unexpected review measurements");
  for (const [kind, selectors] of Object.entries(kinds)) {
    validateMeasuredJourney(receipt.measurements[kind], selectors);
  }
}

function validateMeasuredJourney(observed, selectors) {
  if (
    !observed ||
    JSON.stringify(Object.keys(observed).sort()) !==
      JSON.stringify(["after", "before", "selectors"]) ||
    JSON.stringify(observed.selectors) !== JSON.stringify(selectors)
  )
    throw new Error("review artifact measurements missing");
  for (const side of ["before", "after"]) {
    if (
      !Array.isArray(observed[side]) ||
      observed[side].length !== selectors.length * 2
    )
      throw new Error("review artifact measurements missing");
    for (const [index, value] of observed[side].entries())
      validateMeasurement(value, selectors[index % selectors.length]);
  }
}

function validateMeasurement(value, selector) {
  let text;
  try {
    text = String.prototype.valueOf.call(value);
  } catch {
    throw new Error("review artifact measurement is invalid");
  }
  if (
    text !== value ||
    text.length > 512 ||
    (text === "none" && selector !== "#settings-locking .field__help") ||
    !/^(?:none|\d+x\d+ @-?\d+,-?\d+(?: \| \d+x\d+ @-?\d+,-?\d+)*)$/u.test(text)
  )
    throw new Error("review artifact measurement is invalid");
}

function validateScreenshots(root, receipt) {
  for (const name of expected) {
    const data = readFileSync(path.join(root, name));
    if (
      !data.subarray(0, PNG.length).equals(PNG) ||
      createHash("sha256").update(data).digest("hex") !==
        receipt.screenshots[name]
    )
      throw new Error(
        "review screenshot is invalid or differs from its receipt",
      );
  }
}

/** Accept only four bounded PNGs and an exact hash receipt. */
export function validateArtifact(root, base, head) {
  validateNames(root);
  const receipt = JSON.parse(
    readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  validateReceipt(receipt, base, head);
  validateMeasurements(receipt);
  validateScreenshots(root, receipt);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, directoryPath] = process.argv.slice(2);
  if (mode === "dist") validateDist(directoryPath);
  else if (mode === "artifact")
    validateArtifact(
      directoryPath,
      process.env.PR_VISUAL_BASE_SHA,
      process.env.PR_VISUAL_HEAD_SHA,
    );
  else throw new Error("expected dist or artifact validation");
}
