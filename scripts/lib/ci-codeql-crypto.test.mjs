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

/** Sparse-checkout path lists in one job body, in file order. */
function sparseCheckoutLists(job) {
  const lists = [];
  const lines = job.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s+sparse-checkout:\s*\|$/.test(lines[index])) continue;
    const paths = [];
    for (const line of lines.slice(index + 1)) {
      const entry = /^(\s+)(\S.*)$/.exec(line);
      if (!entry) break;
      paths.push(entry[2].trim());
    }
    lists.push(paths);
    index += paths.length;
  }
  return lists;
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
  expect(analyze).toContain("apps/android/scripts/build-core.sh android");
  const lists = sparseCheckoutLists(analyze);
  expect(lists.length).toBeGreaterThan(0);
  // The matrix shares the first checkout. Cargo applies
  // [patch.crates-io] keepass from patches/vendor/keepass-0.17.0.
  for (const paths of lists) {
    expect(paths).toContain("/patches/vendor");
  }
  expect(lists[0].indexOf("/patches/vendor")).toBeGreaterThan(
    lists[0].indexOf("/tsconfig.base.json"),
  );
});
