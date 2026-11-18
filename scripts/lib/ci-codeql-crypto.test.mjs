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
