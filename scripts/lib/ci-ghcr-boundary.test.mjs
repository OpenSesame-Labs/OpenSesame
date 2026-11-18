import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { parse } from "yaml";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { test } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;
const text = readFileSync(
  join(repoRootFromHere(), ".github/workflows/cd-ghcr-publish.yml"),
  "utf8",
);
const workflow = parse(text);

function checkLocalTags(step, image) {
  const temp = mkdtempSync(join(tmpdir(), "ghcr-proof-tags-"));
  try {
    const output = join(temp, "output");
    const result = spawnSync("bash", ["-c", step.run], {
      env: { PATH: process.env.PATH, IMAGE_NAME: image, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(output, "utf8"),
      `version=0.0.0-local\nlist=${image}:local\n`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function checkImageJob(id, image) {
  const job = workflow.jobs[id];
  assert.equal(job.environment, undefined, id);
  assert.equal(job.permissions.packages, undefined, id);
  assert.equal(job.permissions["id-token"], undefined, id);
  assert.equal(job.permissions.attestations, undefined, id);
  const build = job.steps.find((step) => step.name === "Build");
  const smoke = job.steps.find((step) => step.name === "Smoke image");
  const tags = job.steps.find((step) => step.name === "Image tags");
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, true);
  assert.equal(build.with.provenance, false);
  assert.equal(smoke.if, "steps.dockerfile.outputs.present == 'true'");
  assert.equal(tags.if, smoke.if);
  checkLocalTags(tags, image);
}

test("all refs are local proof builds with no publication authority", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.push.tags, undefined);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.doesNotMatch(
    text,
    /GHCR_PUBLISH_TOKEN|secrets\.GITHUB_TOKEN|docker\/login-action|docker push|imagetools create/,
  );
  for (const [id, image] of [
    ["images", "cli"],
    ["opensesame-amd64", "opensesame"],
    ["web-pwa-amd64", "web-pwa"],
  ]) {
    checkImageJob(id, image);
  }
  const notice = workflow.jobs["publication-disabled"];
  assert.deepEqual(notice.permissions, {});
  assert.match(notice.steps[0].run, /qualified OCI candidates/);
  assert.equal(workflow.jobs.manifests, undefined);
});
