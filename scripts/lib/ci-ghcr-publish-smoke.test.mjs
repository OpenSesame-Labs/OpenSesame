import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as nodeTest from "node:test";
import { imageLeaf, probePlan } from "../ci/oci-image-smoke.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { describe, it } =
  process.env.VITEST === "true" ? await import("vitest") : nodeTest;

const root = repoRootFromHere();

describe("oci image smoke", () => {
  it("classifies version and http probes", () => {
    assert.equal(imageLeaf("ghcr.io/opensesame-labs/cli:next"), "cli");
    assert.deepEqual(probePlan("ghcr.io/opensesame-labs/opensesame:sha-abc"), {
      kind: "version",
    });
    assert.equal(probePlan("web-pwa:local").port, 5180);
    assert.equal(probePlan("control-plane:local").optional, true);
    assert.equal(probePlan("control-plane:local").path, "/v1/health/live");
  });

  it("skips when docker is missing or no image was named", () => {
    const ran = spawnSync(
      process.execPath,
      [join(root, "scripts/ci/oci-image-smoke.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(
      ran.stdout,
      /oci-image-smoke: (docker unavailable, skip|no image arguments, skip)/,
    );
  });
});
