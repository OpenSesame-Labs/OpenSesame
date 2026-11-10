// The release kit (ADR 0212): the workflow's shape and where its edits send CI.
// The trusted control checkouts are pinned in ci-release-kit-control.test.mjs
// and the archive script's bytes in ci-release-kit-archive.test.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";
import { driverReach, gatesForPath } from "./ci-gates.mjs";
import { readString } from "./json-boundary.mjs";

// The `yaml` package npm run hoists privately, loaded the way
// scripts/security/verified-backports.mjs loads it.
const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const root = repoRootFromHere();
const workflow = ".github/workflows/candidate-build.yml";
const yaml = readFileSync(join(root, workflow), "utf8");
const producer = parse(yaml);
const publisherText = readFileSync(
  join(root, ".github/workflows/release-publish.yml"),
  "utf8",
);
const publisher = parse(publisherText);
const guide = readFileSync(join(root, "docs/operators/release-kit.md"), "utf8");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";

function runScripts(text) {
  return Object.values(parse(text).jobs).flatMap((definition) =>
    (definition.steps ?? []).flatMap((step) => {
      const body = readString(step.run);
      return body === undefined ? [] : [body];
    }),
  );
}

const jobScripts = (definition) =>
  (definition.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("candidate producer workflow", () => {
  it("builds only selected snapshots and requires exact successful fast-CI evidence", () => {
    expect(Object.keys(producer.on).sort()).toEqual(["workflow_call"]);
    expect(Object.keys(producer.on.workflow_call.inputs).sort()).toEqual([
      "source_ci_run_attempt",
      "source_ci_run_id",
      "source_sha",
    ]);
    const resolve = jobScripts(producer.jobs.resolve);
    expect(resolve).toContain('[ "$GITHUB_REF" = refs/heads/main ]');
    expect(resolve).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main',
    );
    expect(resolve).toContain("'head_branch': 'main', 'event': 'push'");
    expect(resolve).toContain("'status': 'completed', 'conclusion': 'success'");
    expect(
      producer.jobs.resolve.steps.some(
        (step) => step.with?.["fetch-depth"] === 0,
      ),
    ).toBe(true);
  });

  it("copies shipped proxy bytes before building the separately named TEST variant", () => {
    const build = jobScripts(producer.jobs["native-untrusted"]);
    expect(
      build.indexOf(
        "cp target/release/opensesame-surrogate-proxy bins/opensesame-surrogate-proxy\n",
      ),
    ).toBeLessThan(build.indexOf("--features upstream-override"));
    expect(build).toContain(`bins/${TEST_BUILD}`);
    expect(build).toContain(
      "--locked --release -p opensesame-cli --bin opensesame",
    );
    expect(
      producer.jobs["native-untrusted"].strategy.matrix.include
        .map((item) => item.target)
        .sort(),
    ).toEqual(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
    expect(build).toContain("smoke-kit.sh");
  });

  it("signs all exact payloads before making the candidate available", () => {
    const final = producer.jobs.manifest;
    expect(final.name).toBe("Candidate build gate");
    expect(final.permissions).toEqual({
      contents: "read",
      actions: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(jobScripts(final)).toContain("collect-build.mjs");
    expect(jobScripts(final)).toContain("build-manifest.py");
    const attest = final.steps.findIndex((step) =>
      step.uses?.startsWith("actions/attest@"),
    );
    const upload = final.steps.findIndex((step) => step.id === "upload");
    expect(attest).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(attest);
    expect(final.steps[attest].with["subject-checksums"]).toBe(
      "build-subjects.sha256",
    );
    expect(final.steps[attest].with["predicate-type"]).toBe(
      "https://opensesame.dev/attestations/candidate-build/v1",
    );
    expect(final.steps[upload].with["retention-days"]).toBeGreaterThanOrEqual(
      35,
    );
    expect(
      final.steps.some((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      ),
    ).toBe(false);
    expect(jobScripts(producer.jobs["accept-bridge"])).toContain(
      "artifact-transfer.mjs named",
    );
    expect(producer.jobs["native-untrusted"].needs).toContain("accept-bridge");
    expect(
      producer.jobs["native-untrusted"].steps.some((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      ),
    ).toBe(true);
  });
});

describe("artifact publication workflow", () => {
  it("can only be called with the candidate and three qualification receipts", () => {
    expect(Object.keys(publisher.on)).toEqual(["workflow_call"]);
    expect(Object.keys(publisher.on.workflow_call.inputs)).toHaveLength(10);
    expect(publisher.permissions).toEqual({});
    expect(publisher.concurrency["cancel-in-progress"]).toBe(false);
    for (const job of Object.values(publisher.jobs))
      expect(jobScripts(job)).toContain("verify-promotion");
  });

  it("gates every contents-write job and waits for Pages before publication", () => {
    const ungatedWrites = (jobs, workflowPermissions = {}) =>
      Object.entries(jobs).flatMap(([name, job]) => {
        const permissions = job.permissions ?? workflowPermissions;
        const writesContents =
          permissions === "write-all" || permissions?.contents === "write";
        const environment = job.environment;
        return writesContents &&
          environment !== "release" &&
          environment?.name !== "release"
          ? [name]
          : [];
      });
    expect(ungatedWrites(publisher.jobs, publisher.permissions)).toEqual([]);
    expect(ungatedWrites({ rogue: {} }, { contents: "write" })).toEqual([
      "rogue",
    ]);
    expect(ungatedWrites({ rogue: {} }, "write-all")).toEqual(["rogue"]);
    expect(
      ungatedWrites({ rogue: { permissions: { contents: "write" } } }),
    ).toEqual(["rogue"]);
    expect(ungatedWrites({ rogue: { permissions: "write-all" } })).toEqual([
      "rogue",
    ]);
    expect(publisher.jobs.stage.needs).toBe("admission");
    expect(publisher.jobs.stage.environment).toEqual({
      name: "release",
      url: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ inputs.run_id }}",
    });
    expect(publisher.jobs.publish.environment).toEqual({
      name: "release",
      url: "${{ needs.stage.outputs.draft_url }}",
    });
    expect(publisher.jobs.stage.outputs.draft_url).toBe(
      "${{ steps.draft.outputs.draft_url }}",
    );
    expect(publisher.jobs.pages.environment.name).toBe("github-pages");
    expect(publisher.jobs.pages.needs).toContain("stage");
    expect(publisher.jobs.publish.needs).toContain("stage");
    expect(publisher.jobs.publish.needs).toContain("pages");
    expect(jobScripts(publisher.jobs.stage)).toContain(
      "publish-release.mjs prepare",
    );
    expect(jobScripts(publisher.jobs.publish)).toContain(
      "publish-release.mjs publish",
    );
  });

  it("promotes the exact existing archive without source builds or stamping", () => {
    const bodies = runScripts(publisherText).join("\n");
    expect(bodies).not.toMatch(
      /cargo .*build|turbo .*build|npm run .*build|pages-release\.mjs stamp/,
    );
    expect(bodies).toContain(
      'gzip -dc "$PAGES_ARCHIVE" > hosting/artifact.tar',
    );
    expect(bodies).toContain("downloadArtifact(");
    expect(bodies).toContain(
      "cmp hosting/artifact.tar hosting-checked/artifact.tar",
    );
    expect(bodies).toContain("verify-site.mjs");
    const sign = publisher.jobs.stage.steps.find((step) =>
      step.uses?.startsWith("actions/attest@"),
    );
    expect(sign.with["predicate-type"]).toBe(
      "https://opensesame.dev/attestations/release-promotion/v1",
    );
  });

  it("documents exact signer and main-ref verification plus draft-only recovery", () => {
    expect(guide).toContain("--signer-workflow");
    expect(guide).toContain("candidate-build.yml");
    expect(guide).toContain("release-publish.yml");
    expect(guide).toContain("--source-ref refs/heads/main");
    expect(guide).toContain("unpublished draft");
  });
});

describe("release workflow safety and routing", () => {
  it("pins every external action and keeps expressions out of shell bodies", () => {
    for (const text of [yaml, publisherText]) {
      for (const [, action] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm))
        expect(action).toMatch(/^[\w./-]+@[a-f0-9]{40}$/);
      expect(text).not.toContain("pull_request_target");
      for (const body of runScripts(text)) expect(body).not.toContain("${{");
    }
  });

  it("routes native kit workflow and helper edits to TypeScript protocol checks", () => {
    expect(areasForPaths([workflow]).typescript).toBe(true);
    for (const path of [
      workflow,
      "scripts/release/kit-archive.sh",
      "scripts/release/tag-check.sh",
      "packages/env-spec-bridge/scripts/bundle.mjs",
    ]) {
      expect(gatesForPath(path, driverReach(root)), path).toEqual(new Set());
    }
  });
});
