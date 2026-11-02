import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import {
  assertDistinctHashes,
  assertProfileProof,
  proofManifest,
  stitchPanels,
} from "./pwa-profile-proof-gate.mjs";
import { mergeProfileProof } from "./pwa-profile-proof-merge.mjs";
import { walksForProof } from "./pwa-profile-proof-select.mjs";

function entry(profile, extra) {
  return {
    profile,
    setupChoice: profile,
    buildKey: profile,
    distDigest: extra.dist,
    pngHash: extra.png,
    distinguishHash: extra.distinguish,
    choiceHash: extra.choice,
    distinguish: extra.distinguishName ?? "features",
    switchesOn: extra.switchesOn,
    ceremonyReached: extra.ceremonyReached === true,
  };
}

function sample() {
  return [
    entry("minimal-local", {
      dist: "minimal",
      png: "p1",
      distinguish: "d1",
      choice: "c1",
      switchesOn: 1,
    }),
    entry("default", {
      dist: "stock",
      png: "p2",
      distinguish: "d2",
      choice: "c2",
      switchesOn: 4,
    }),
    entry("custom", {
      dist: "stock",
      png: "p3",
      distinguish: "d3",
      choice: "c3",
      ceremonyReached: true,
      distinguishName: "setup-capabilities",
    }),
    entry("full", {
      dist: "full",
      png: "p4",
      distinguish: "d4",
      choice: "c4",
      switchesOn: 9,
    }),
  ];
}

test("profile proof accepts four distinct walks on three builds", () => {
  assert.doesNotThrow(() => assertProfileProof(sample()));
});

test("shared profile PNGs fail with both names and the hash", () => {
  const entries = sample();
  entries[1].pngHash = entries[2].pngHash;
  assert.throws(
    () => assertProfileProof(entries),
    /profile PNG: default and custom both hash p3/,
  );
});

test("shared distinguishing screenshots fail even when composites differ", () => {
  const entries = sample();
  entries[0].distinguishHash = entries[3].distinguishHash;
  assert.throws(
    () => assertProfileProof(entries),
    /distinguishing screenshot: minimal-local and full both hash d4/,
  );
});

test("default and custom must share the stock dist", () => {
  const entries = sample();
  entries[2].distDigest = "other";
  assert.throws(
    () => assertProfileProof(entries),
    /default and custom must share the stock build/,
  );
});

test("capability profile dists must differ from stock", () => {
  const entries = sample();
  entries[0].distDigest = "stock";
  assert.throws(
    () => assertProfileProof(entries),
    /minimal-local, stock, and full dists must differ/,
  );
});

test("feature switches must increase minimal, default, full", () => {
  const entries = sample();
  entries[3].switchesOn = entries[1].switchesOn;
  assert.throws(
    () => assertProfileProof(entries),
    /Features switches must increase/,
  );
});

test("custom must reach the capabilities ceremony", () => {
  const entries = sample();
  entries[2].ceremonyReached = false;
  assert.throws(
    () => assertProfileProof(entries),
    /custom did not reach the capabilities ceremony/,
  );
});

test("manifest records profile, dist digest, and png hash", () => {
  const manifest = proofManifest(sample());
  assert.deepEqual(
    manifest.profiles.map((item) => ({
      profile: item.profile,
      distDigest: item.distDigest,
      pngHash: item.pngHash,
    })),
    [
      { profile: "minimal-local", distDigest: "minimal", pngHash: "p1" },
      { profile: "default", distDigest: "stock", pngHash: "p2" },
      { profile: "custom", distDigest: "stock", pngHash: "p3" },
      { profile: "full", distDigest: "full", pngHash: "p4" },
    ],
  );
  assert.equal(manifest.profiles[2].ceremonyReached, true);
  assert.equal(manifest.profiles[2].switchesOn, null);
});

test("distinct hash rows reject a collision", () => {
  assert.throws(
    () =>
      assertDistinctHashes([
        { profile: "default", hash: "abc", label: "profile PNG" },
        { profile: "custom", hash: "abc", label: "profile PNG" },
      ]),
    /default and custom both hash abc/,
  );
});

test("stitch stacks both panels into a taller png", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwa-proof-"));
  try {
    const top = join(dir, "top.png");
    const bottom = join(dir, "bottom.png");
    const out = join(dir, "out.png");
    const other = join(dir, "other.png");
    await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 3,
        background: { r: 17, g: 34, b: 51 },
      },
    })
      .png()
      .toFile(top);
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 170, g: 187, b: 204 },
      },
    })
      .png()
      .toFile(bottom);
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 200, g: 20, b: 20 },
      },
    })
      .png()
      .toFile(other);
    await stitchPanels(
      [
        { path: top, label: "Front door" },
        { path: bottom, label: "Features" },
      ],
      out,
    );
    const stitched = await sharp(out).metadata();
    assert.equal(stitched.width, 8);
    assert.ok((stitched.height ?? 0) > 10);
    const again = join(dir, "again.png");
    await stitchPanels(
      [
        { path: top, label: "Front door" },
        { path: other, label: "Features" },
      ],
      again,
    );
    const first = createHash("sha256")
      .update(await readFile(out))
      .digest("hex");
    const second = createHash("sha256")
      .update(await readFile(again))
      .digest("hex");
    assert.notEqual(first, second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const walks = [
  { name: "minimal-local" },
  { name: "default" },
  { name: "custom" },
  { name: "full" },
];

test("an empty profile request keeps every walk", () => {
  assert.deepEqual(walksForProof(walks, undefined), walks);
  assert.deepEqual(walksForProof(walks, ""), walks);
  assert.deepEqual(walksForProof(walks, "  "), walks);
});

test("a named profile request keeps that walk", () => {
  assert.deepEqual(walksForProof(walks, "default"), [{ name: "default" }]);
  assert.deepEqual(walksForProof(walks, " full "), [{ name: "full" }]);
});

test("an unknown profile name lists the valid names", () => {
  assert.throws(
    () => walksForProof(walks, "nightly"),
    /unknown profile "nightly"; valid: minimal-local, default, custom, full/,
  );
});

async function writePart(dir, entry) {
  const part = join(dir, entry.profile);
  await mkdir(part, { recursive: true });
  await writeFile(join(part, "entry.json"), `${JSON.stringify(entry)}\n`);
  await writeFile(join(part, `${entry.profile}.png`), entry.pngHash);
}

test("merge accepts four distinct profile artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwa-merge-"));
  try {
    const parts = join(dir, "parts");
    const out = join(dir, "out");
    for (const entry of sample()) {
      await writePart(join(parts, "run"), entry);
    }
    const manifest = await mergeProfileProof(parts, out);
    assert.deepEqual(
      manifest.profiles.map((item) => item.profile),
      ["minimal-local", "default", "custom", "full"],
    );
    assert.equal(await readFile(join(out, "default.png"), "utf8"), "p2");
    const written = JSON.parse(
      await readFile(join(out, "manifest.json"), "utf8"),
    );
    assert.equal(written.profiles[2].ceremonyReached, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("merge rejects a shared profile hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwa-merge-"));
  try {
    const parts = join(dir, "parts");
    const entries = sample();
    entries[1].pngHash = entries[2].pngHash;
    for (const entry of entries) await writePart(parts, entry);
    await assert.rejects(
      () => mergeProfileProof(parts, join(dir, "out")),
      /profile PNG: default and custom both hash p3/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("merge rejects a duplicate profile entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwa-merge-"));
  try {
    const parts = join(dir, "parts");
    for (const entry of sample()) await writePart(join(parts, "a"), entry);
    await writePart(join(parts, "b"), sample()[1]);
    await assert.rejects(
      () => mergeProfileProof(parts, join(dir, "out")),
      /expected 4 profile entries, found 5/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assert and merge modules do not import sharp", () => {
  for (const name of [
    "pwa-profile-proof-assert.mjs",
    "pwa-profile-proof-merge.mjs",
    "pwa-profile-proof-select.mjs",
  ]) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "sharp"/);
  }
});

test("cd-pwa proves four profiles in parallel and gates them", () => {
  const text = readFileSync(
    new URL("../../.github/workflows/cd-pwa.yml", import.meta.url),
    "utf8",
  );
  assert.match(text, /fail-fast: false/);
  assert.match(text, /profile: \[minimal-local, default, custom, full\]/);
  assert.match(text, /PWA_PROFILE_PROOF_NAME: \$\{\{ matrix\.profile \}\}/);
  assert.match(
    text,
    /name: pwa-profile-proof-\$\{\{ matrix\.profile \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(
    text,
    /pattern: pwa-profile-proof-\*-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(text, /merge-multiple: false/);
  assert.match(text, /pwa-profile-proof-merge\.mjs/);
  assert.match(text, /timeout-minutes: 60/);
  const gate = text.split("\n  proof-gate:\n")[1]?.split("\n  build:\n")[0];
  assert.match(gate ?? "", /needs: proof\n/);
  assert.match(gate ?? "", /timeout-minutes: 30/);
  const build = text.split("\n  build:\n")[1]?.split("\n  npm_preview:\n")[0];
  assert.match(build ?? "", /needs: proof-gate\n/);
  assert.equal((text.match(/run: npm run build/g) ?? []).length, 1);
});
