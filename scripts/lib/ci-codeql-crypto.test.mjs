import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

it("compiles reviewed x/crypto tests through the checksum-verified overlay", () => {
  const workflow = readFileSync(
    join(repoRootFromHere(), ".github/workflows/codeql.yml"),
    "utf8",
  );
  const analyze = workflow
    .split("\n  analyze:\n")[1]
    .split(/\n {2}[a-z][a-z0-9-]*:\n/)[0];
  const extract = analyze
    .split(
      "- name: Extract live-turn and its reviewed local crypto module\n",
    )[1]
    .split(/\n {6}- /)[0];
  const baseline = extract.indexOf(
    "python3 scripts/test/live-turn/verify-crypto-subset.py\n",
  );
  const overlayVerify = extract.indexOf(
    'verify-crypto-subset.py --upstream-metadata "$scratch/upstream.json" --overlay "$scratch/overlay.json"',
  );
  expect(baseline).toBeGreaterThanOrEqual(0);
  expect(overlayVerify).toBeGreaterThan(baseline);
  expect(extract).toContain(
    'go mod download -json "golang.org/x/crypto@$version"',
  );
  const compile = extract.indexOf(
    'go test -c -overlay "$scratch/overlay.json" -o "$RUNNER_TEMP/codeql-xcrypto.test"',
  );
  expect(compile).toBeGreaterThan(overlayVerify);
});

function leadingSpaces(line) {
  const match = /^\s*/.exec(line);
  return match === null ? 0 : match[0].length;
}

/**
 * Sparse-checkout path lists in `text`, in file order.
 * Each list keeps only lines indented deeper than its `sparse-checkout:` key.
 * A line at that indent or shallower ends the list, so sibling keys such as
 * `uses:`, `if:`, and `with:` are not consumed.
 */
function sparseCheckoutLists(text) {
  const lists = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const key = /^(\s+)sparse-checkout:\s*\|$/.exec(lines[index]);
    if (!key) continue;
    const keyIndent = key[1].length;
    const paths = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim().length === 0) break;
      if (leadingSpaces(line) <= keyIndent) break;
      paths.push(line.trim());
    }
    lists.push(paths);
    index += paths.length;
  }
  return lists;
}

/** Step bodies under `steps:`, in order. */
function jobSteps(job) {
  const lines = job.split("\n");
  const header = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (header < 0) return [];
  const steps = [];
  let current = null;
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith("      - ")) {
      if (current) steps.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current === null) continue;
    if (line.trim().length > 0 && leadingSpaces(line) < 6) break;
    current.push(line);
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/** Step-level `if:` value, or null when the step always runs. */
function stepIf(step) {
  const lines = step.split("\n");
  const keyIndent = leadingSpaces(lines[0]) + 2;
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    if (leadingSpaces(line) !== keyIndent) continue;
    const match = /^if:\s*(.+)$/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

function stepName(step) {
  const match = /^ {6}- name: (.+)$/.exec(step.split("\n")[0]);
  return match ? match[1] : null;
}

it("checks out vendored crates for the CodeQL Android and Rust build", () => {
  const workflow = readFileSync(
    join(repoRootFromHere(), ".github/workflows/codeql.yml"),
    "utf8",
  );
  const analyze = workflow
    .split("\n  analyze:\n")[1]
    .split(/\n {2}[a-z][a-z0-9-]*:\n/)[0];
  expect(analyze).toContain("- language: rust\n");
  expect(analyze).toContain("- language: java-kotlin\n");

  const steps = jobSteps(analyze);
  const androidAt = steps.findIndex(
    (step) => stepName(step) === "Build Android native libraries",
  );
  expect(androidAt).toBeGreaterThan(0);
  expect(stepIf(steps[androidAt])).toBe("matrix.language == 'java-kotlin'");
  expect(steps[androidAt]).toContain(
    "apps/android/scripts/build-core.sh android",
  );

  const checkoutAt = steps.findIndex((step) =>
    step.startsWith("      - uses: actions/checkout@"),
  );
  expect(checkoutAt).toBeGreaterThanOrEqual(0);
  expect(checkoutAt).toBeLessThan(androidAt);
  // This checkout has no `if:`, so java-kotlin uses the same tree.
  expect(stepIf(steps[checkoutAt])).toBeNull();

  const checkoutLists = sparseCheckoutLists(steps[checkoutAt]);
  expect(checkoutLists.length).toBe(1);
  const paths = checkoutLists[0];
  // The steps after this checkout stay in the scanned text. The path list
  // is still only that checkout's block.
  const withLaterSteps = sparseCheckoutLists(
    steps.slice(checkoutAt).join("\n"),
  );
  expect(withLaterSteps[0]).toEqual(paths);
  expect(
    withLaterSteps[0].filter((path) =>
      /^(?:-\s+)?(?:uses|if|with):/.test(path),
    ),
  ).toEqual([]);
  // Cargo applies [patch.crates-io] keepass from patches/vendor/keepass-0.17.0.
  expect(paths).toContain("/patches/vendor");
  expect(paths.indexOf("/patches/vendor")).toBeGreaterThan(
    paths.indexOf("/tsconfig.base.json"),
  );
  expect(paths).not.toContain(
    "run: apps/android/scripts/build-core.sh android",
  );
});
