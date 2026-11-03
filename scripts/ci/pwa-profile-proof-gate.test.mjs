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
  assertFullProfileProof,
  assertProfileProof,
  proofManifest,
  stitchPanels,
} from "./pwa-profile-proof-gate.mjs";
import {
  FULL_INSTALL_PROFILE_PROOF_NAME,
  walksForProof,
} from "./pwa-profile-proof-select.mjs";

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

function fullEntry() {
  return entry("full", {
    dist: "full-dist",
    png: "png-full",
    distinguish: "d-full",
    choice: "c-full",
    switchesOn: 9,
  });
}

test("profile proof accepts four distinct walks on three builds", () => {
  assert.doesNotThrow(() => assertProfileProof(sample()));
});

test("full profile proof accepts one full walk", () => {
  assert.doesNotThrow(() => assertFullProfileProof([fullEntry()]));
});

test("full profile proof rejects wrong profile name", () => {
  const wrong = fullEntry();
  wrong.profile = "default";
  assert.throws(
    () => assertFullProfileProof([wrong]),
    /expected profile full/,
  );
});

test("full profile proof rejects missing screenshot fields", () => {
  const incomplete = fullEntry();
  incomplete.pngHash = "";
  assert.throws(() => assertFullProfileProof([incomplete]), /missing pngHash/);
});

test("shared profile PNGs fail with both names and the hash", () => {
  const entries = sample();
  entries[1].pngHash = entries[2].pngHash;
  assert.throws(
    () => assertProfileProof(entries),
    /profile PNG: default and custom both hash p3/,
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

test("an empty profile request keeps every walk for local runs", () => {
  assert.deepEqual(walksForProof(walks, undefined), walks);
  assert.deepEqual(walksForProof(walks, ""), walks);
  assert.deepEqual(walksForProof(walks, "  "), walks);
});

test("a named profile request keeps that walk", () => {
  assert.deepEqual(walksForProof(walks, "default"), [{ name: "default" }]);
  assert.deepEqual(walksForProof(walks, " full "), [{ name: "full" }]);
});

test("CD constant names the full profile", () => {
  assert.equal(FULL_INSTALL_PROFILE_PROOF_NAME, "full");
});

test("assert module does not import sharp", () => {
  const source = readFileSync(
    new URL("./pwa-profile-proof-assert.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from "sharp"/);
});

test("cd-pwa proves the full install profile only", () => {
  const text = readFileSync(
    new URL("../../.github/workflows/cd-pwa.yml", import.meta.url),
    "utf8",
  );
  assert.match(text, /name: Build install profile \(full\)/);
  assert.match(text, /PWA_PROFILE_PROOF_NAME: full/);
  assert.match(text, /name: pwa-profile-proof-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(text, /profile: \[minimal-local, default, custom, full\]/);
  assert.doesNotMatch(text, /proof-gate:/);
  assert.match(text, /timeout-minutes: 60/);
  const build = text.split("\n  build:\n")[1]?.split("\n  npm_preview:\n")[0];
  assert.match(build ?? "", /\n {4}needs: \[main_ci\]\n/);
  assert.doesNotMatch(build ?? "", /needs:.*proof/);
  const preview = text
    .split("\n  npm_preview:\n")[1]
    ?.split("\n  deploy:\n")[0];
  const deploy = text
    .split("\n  deploy:\n")[1]
    ?.split("\n  preview_smoke:\n")[0];
  assert.match(preview ?? "", /needs: \[build, proof\]/);
  assert.match(deploy ?? "", /needs: \[build, proof\]/);
  const smoke = text
    .split("\n  preview_smoke:\n")[1]
    ?.split("\n  production:\n")[0];
  assert.match(smoke ?? "", /timeout-minutes: 30/);
  assert.match(
    text,
    /needs: \[main_ci, proof, build, deploy, npm_preview, preview_smoke\]/,
  );
  assert.equal((text.match(/run: npm run build/g) ?? []).length, 1);
});

test("pull-request profile proof uses the full profile only", () => {
  const text = readFileSync(
    new URL(
      "../../.github/workflows/cd-pwa-profile-proof.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(text, /name: Install-profile screenshot \(full\)/);
  assert.match(text, /PWA_PROFILE_PROOF_NAME: full/);
  assert.doesNotMatch(text, /profile: \[minimal-local, default, custom, full\]/);
  assert.doesNotMatch(text, /proof-gate:/);
  assert.match(text, /timeout-minutes: 60/);
  assert.match(text, /cache: false/);
});
