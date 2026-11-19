import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/auth/coverage.json`, "utf8"),
);
const attestationPath = coverage.reviewed_attestation;
const attestationPathPattern =
  /^spec\/formal\/auth\/reviewed-sources(?:-[a-z0-9-]+)?\.json$/;
const paths = [
  "packages/control-plane/src/middleware/auth.ts",
  "packages/control-plane/src/proofs/verified-principal.ts",
  "packages/control-plane/src/proofs/project-role.ts",
  "packages/control-plane/src/services/project-access.ts",
  "packages/os-domain/src/types.ts",
];
const authC1Paths = [
  "packages/app-core/src/lib/identity.ts",
  "packages/app-core/src/lib/identity-probe.ts",
  "packages/app-core/src/lib/identity-token-proof.ts",
  "packages/app-core/src/lib/identity-session-types.ts",
  "packages/app-core/src/lib/device-identity.ts",
  "packages/app-core/src/lib/browser-pairing.ts",
  "packages/app-core/src/lib/guest-auth.ts",
  "packages/app-core/src/lib/federation.ts",
  "packages/app-core/src/lib/claims/transport.ts",
  "packages/app-core/src/lib/claims/ceremony.ts",
  "packages/control-plane/src/app.ts",
  "packages/control-plane/src/routes/principals.ts",
  "apps/pages/src/components/IdentityCeremony.tsx",
  "apps/pages/src/components/ConnectionCeremony.tsx",
  "apps/pages/src/components/status-mark.css",
  "apps/pages/src/screens/FrontDoor.tsx",
  "apps/pages/src/screens/door.css",
  "apps/pages/src/screens/unlock/GuestRoad.tsx",
];
const revisionEvidence =
  coverage.version === 1 && /^[0-9a-f]{40}$/.test(coverage.reviewed_revision);
const blobEvidence =
  coverage.version === 2 &&
  isString(attestationPath) &&
  attestationPathPattern.test(attestationPath);
const shallow =
  execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: root,
    encoding: "utf8",
  }).trim() === "true";
function gitJson(revision, path) {
  return JSON.parse(
    execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}
function validateAuthC1Snapshot() {
  const formalAuth = readFileSync(
    `${root}/docs/security/formal-auth-verification.md`,
    "utf8",
  );
  const snapshot = formalAuth.match(
    /AUTH-C1 was independently reviewed[\s\S]*?future changes require a new\s+independent review and snapshot update:\n(?<rows>(?:\n- `[^`]+`: `[0-9a-f]{40}`)+)/,
  );
  if (!snapshot?.groups?.rows)
    throw new Error("auth-formal: missing AUTH-C1 reviewed-source snapshot");
  const sources = [
    ...snapshot.groups.rows.matchAll(/^- `([^`]+)`: `([0-9a-f]{40})`$/gm),
  ].map((match) => ({ path: match[1], blob: match[2] }));
  if (
    sources.length !== authC1Paths.length ||
    authC1Paths.some((path, index) => sources[index]?.path !== path)
  )
    throw new Error("auth-formal: invalid AUTH-C1 source inventory");
  for (const entry of sources) {
    const bytes = readFileSync(`${root}/${entry.path}`);
    const actual = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actual !== entry.blob)
      throw new Error("auth-formal: AUTH-C1 source drift");
  }
}
function v2ExistsInHistory() {
  if (shallow) return false;
  const args =
    "log --full-history --format=%H -- spec/formal/auth/coverage.json".split(
      " ",
    );
  const commits = execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  return commits.some((commit) => {
    try {
      return gitJson(commit, "spec/formal/auth/coverage.json").version === 2;
    } catch {
      return false;
    }
  });
}
function validV2Manifest(manifest) {
  return (
    manifest?.version === 2 &&
    isString(manifest.reviewed_attestation) &&
    attestationPathPattern.test(manifest.reviewed_attestation) &&
    Array.isArray(manifest.sources) &&
    manifest.sources.length === paths.length &&
    paths.every(
      (path, index) =>
        manifest.sources[index]?.path === path &&
        /^[0-9a-f]{40}$/.test(manifest.sources[index]?.base_blob) &&
        /^[0-9a-f]{40}$/.test(manifest.sources[index]?.reviewed_blob),
    )
  );
}
function validatePreviousCoverage(parent, previousCoverage, seen = new Set()) {
  if (previousCoverage.version !== 2) return;
  if (!validV2Manifest(previousCoverage))
    throw new Error("auth-formal: invalid prior covered-source manifest");
  let previousAttestation;
  try {
    previousAttestation = gitJson(
      parent,
      previousCoverage.reviewed_attestation,
    );
  } catch {
    throw new Error(
      "auth-formal: prior reviewed-source attestation unavailable",
    );
  }
  if (
    previousAttestation.version !== 1 ||
    JSON.stringify(previousAttestation.sources) !==
      JSON.stringify(previousCoverage.sources)
  ) {
    throw new Error(
      "auth-formal: prior manifest does not match its reviewed-source attestation",
    );
  }
  for (const entry of previousCoverage.sources) {
    const sourceBlob = execFileSync(
      "git",
      ["rev-parse", `${parent}:${entry.path}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    if (sourceBlob !== entry.reviewed_blob)
      throw new Error(
        `auth-formal: prior manifest did not validate source ${entry.path}`,
      );
    const reviewed = execFileSync(
      "git",
      ["cat-file", "blob", entry.reviewed_blob],
      {
        cwd: root,
      },
    );
    if (createHash("sha256").update(reviewed).digest("hex") !== entry.sha256)
      throw new Error(
        `auth-formal: prior reviewed source digest mismatch for ${entry.path}`,
      );
  }
  validatePriorAttestationProvenance(parent, previousCoverage, seen);
}
function validatePriorAttestationProvenance(parent, previousCoverage, seen) {
  const reviewedCommit = execFileSync(
    "git",
    [
      "log",
      "-1",
      "--format=%H",
      parent,
      "--",
      previousCoverage.reviewed_attestation,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (!reviewedCommit || seen.has(reviewedCommit))
    throw new Error("auth-formal: invalid prior attestation provenance chain");
  seen.add(reviewedCommit);
  const changed = execFileSync(
    "git",
    [
      "diff-tree",
      "-m",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      reviewedCommit,
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  if (paths.some((path) => changed.includes(path)))
    throw new Error(
      "auth-formal: prior reviewed-source attestation did not predate covered source changes",
    );
  let predecessor;
  try {
    predecessor = gitJson(
      `${reviewedCommit}^`,
      "spec/formal/auth/coverage.json",
    );
  } catch {
    throw new Error(
      "auth-formal: prior attestation lacks predecessor evidence",
    );
  }
  validatePreviousCoverage(`${reviewedCommit}^`, predecessor, seen);
  for (const entry of previousCoverage.sources) {
    const base = execFileSync(
      "git",
      ["rev-parse", `${reviewedCommit}^:${entry.path}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    if (
      base !== entry.base_blob ||
      reviewedBlobBefore(reviewedCommit, predecessor, entry) !== entry.base_blob
    )
      throw new Error(
        `auth-formal: prior attestation base lacks reviewed provenance for ${entry.path}`,
      );
  }
}
function reviewedBlobBefore(attestationCommit, previousCoverage, entry) {
  const recorded = previousCoverage.sources?.find(
    (candidate) => candidate.path === entry.path,
  )?.reviewed_blob;
  if (recorded) return recorded;
  if (!/^[0-9a-f]{40}$/.test(previousCoverage.reviewed_revision)) return;
  try {
    return execFileSync(
      "git",
      ["rev-parse", `${previousCoverage.reviewed_revision}:${entry.path}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error(
      `auth-formal: prior review evidence unavailable before ${attestationCommit} for ${entry.path}`,
    );
  }
}
if (revisionEvidence && v2ExistsInHistory())
  throw new Error(
    "auth-formal: v2 reviewed-source evidence cannot downgrade to v1",
  );
if (
  (!revisionEvidence && !blobEvidence) ||
  !Array.isArray(coverage.sources) ||
  coverage.sources.length !== paths.length ||
  paths.some(
    (path, index) =>
      coverage.sources[index]?.path !== path ||
      (blobEvidence &&
        (!/^[0-9a-f]{40}$/.test(coverage.sources[index]?.base_blob) ||
          !/^[0-9a-f]{40}$/.test(coverage.sources[index]?.reviewed_blob))),
  )
) {
  throw new Error("auth-formal: invalid covered-source manifest");
}
let attestation;
if (blobEvidence) {
  try {
    attestation = JSON.parse(
      readFileSync(`${root}/${attestationPath}`, "utf8"),
    );
  } catch {
    throw new Error("auth-formal: reviewed-source attestation unavailable");
  }
  if (
    attestation.version !== 1 ||
    !Array.isArray(attestation.sources) ||
    JSON.stringify(attestation.sources) !== JSON.stringify(coverage.sources)
  ) {
    throw new Error(
      "auth-formal: manifest does not match reviewed-source attestation",
    );
  }
  if (!shallow) {
    const reviewedCommit = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "--", attestationPath],
      { cwd: root, encoding: "utf8" },
    ).trim();
    if (!reviewedCommit) {
      throw new Error(
        "auth-formal: reviewed-source attestation is uncommitted",
      );
    }
    const sameCommit = execFileSync(
      "git",
      [
        "diff-tree",
        "-m",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        reviewedCommit,
      ],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    if (paths.some((path) => sameCommit.includes(path))) {
      throw new Error(
        "auth-formal: reviewed-source attestation must predate covered source changes",
      );
    }
    let previousCoverage;
    try {
      previousCoverage = gitJson(
        `${reviewedCommit}^`,
        "spec/formal/auth/coverage.json",
      );
    } catch {
      throw new Error(
        "auth-formal: reviewed-source attestation lacks prior coverage evidence",
      );
    }
    validatePreviousCoverage(`${reviewedCommit}^`, previousCoverage);
    for (const entry of attestation.sources) {
      let priorBlob;
      try {
        priorBlob = execFileSync(
          "git",
          ["rev-parse", `${reviewedCommit}^:${entry.path}`],
          { cwd: root, encoding: "utf8" },
        ).trim();
      } catch {
        throw new Error(
          `auth-formal: prior covered source unavailable for ${entry.path}`,
        );
      }
      if (priorBlob !== entry.base_blob) {
        throw new Error(
          `auth-formal: reviewed-source attestation followed unreviewed source drift in ${entry.path}`,
        );
      }
      const previouslyReviewedBlob = reviewedBlobBefore(
        reviewedCommit,
        previousCoverage,
        entry,
      );
      if (previouslyReviewedBlob !== entry.base_blob) {
        throw new Error(
          `auth-formal: reviewed-source attestation base is not the prior reviewed source for ${entry.path}`,
        );
      }
    }
  }
}
validateAuthC1Snapshot();
for (const entry of coverage.sources) {
  let reviewed;
  try {
    const evidence = blobEvidence
      ? ["cat-file", "blob", entry.reviewed_blob]
      : ["show", `${coverage.reviewed_revision}:${entry.path}`];
    reviewed = execFileSync("git", evidence, {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch {
    throw new Error(
      `auth-formal: reviewed ${blobEvidence ? "source blob" : "revision or source"} unavailable for ${entry.path}`,
    );
  }
  if (createHash("sha256").update(reviewed).digest("hex") !== entry.sha256) {
    throw new Error(
      `auth-formal: reviewed ${blobEvidence ? "source blob" : "revision"} does not match ${entry.path}`,
    );
  }
  const digest = createHash("sha256")
    .update(readFileSync(`${root}/${entry.path}`))
    .digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(
      `auth-formal: source drift in ${entry.path}; review the model and update coverage.json`,
    );
  }
}
console.log(
  blobEvidence
    ? `auth-formal: covered sources match prior squash-safe reviewed-source attestation; AUTH-C1 snapshot matches ${authC1Paths.length} sources`
    : `auth-formal: covered sources match reviewed revision ${coverage.reviewed_revision}; AUTH-C1 snapshot matches ${authC1Paths.length} sources`,
);
