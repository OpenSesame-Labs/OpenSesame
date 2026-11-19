import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const coverage = JSON.parse(
  readFileSync(`${root}/spec/formal/auth/coverage.json`, "utf8"),
);
const attestationPath = "spec/formal/auth/reviewed-sources.json";
const paths = [
  "packages/control-plane/src/middleware/auth.ts",
  "packages/control-plane/src/proofs/verified-principal.ts",
  "packages/control-plane/src/proofs/project-role.ts",
  "packages/control-plane/src/services/project-access.ts",
  "packages/os-domain/src/types.ts",
];
const revisionEvidence =
  coverage.version === 1 && /^[0-9a-f]{40}$/.test(coverage.reviewed_revision);
const blobEvidence =
  coverage.version === 2 && coverage.reviewed_attestation === attestationPath;

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
  const shallow =
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      encoding: "utf8",
    }).trim() === "true";
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
      previousCoverage = JSON.parse(
        execFileSync(
          "git",
          ["show", `${reviewedCommit}^:spec/formal/auth/coverage.json`],
          { cwd: root, encoding: "utf8" },
        ),
      );
    } catch {
      throw new Error(
        "auth-formal: reviewed-source attestation lacks prior coverage evidence",
      );
    }
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
    ? "auth-formal: covered sources match prior squash-safe reviewed-source attestation"
    : `auth-formal: covered sources match reviewed revision ${coverage.reviewed_revision}`,
);
