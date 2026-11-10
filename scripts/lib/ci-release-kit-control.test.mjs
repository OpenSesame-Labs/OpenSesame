// The release kit (ADR 0212): the candidate producer keeps trusted control
// code apart from the selected application source. Every job checks its
// helpers out at the workflow's own revision, into .ci-control.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

// The `yaml` package npm run hoists privately, loaded the way
// scripts/security/verified-backports.mjs loads it.
const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");

const producer = parse(
  readFileSync(
    join(repoRootFromHere(), ".github/workflows/candidate-build.yml"),
    "utf8",
  ),
);

const jobScripts = (definition) =>
  (definition.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("candidate producer workflow", () => {
  it("separates trusted control code from selected application source", () => {
    for (const name of [
      "bridge-untrusted",
      "pages-untrusted",
      "native-untrusted",
    ]) {
      const job = producer.jobs[name];
      expect(job.permissions).toEqual({ contents: "read", actions: "read" });
      expect(JSON.stringify(job)).not.toContain("github.token");
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(job.env.CANDIDATE_REVISION).toBe(
        "${{ needs.resolve.outputs.source_sha }}",
      );
      const checkouts = job.steps.filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(
        checkouts.find((step) => step.with.path === ".ci-control").with.ref,
      ).toBe("${{ github.workflow_sha }}");
      expect(checkouts.find((step) => step.with.path === "src").with.ref).toBe(
        "${{ env.CANDIDATE_REVISION }}",
      );
    }
    const privileged = ["resolve", "accept-bridge", "manifest"];
    for (const name of privileged) {
      const refs = producer.jobs[name].steps
        .filter((step) => step.uses?.startsWith("actions/checkout@"))
        .map((step) => step.with.ref);
      expect(refs).toEqual(["${{ github.workflow_sha }}"]);
    }
  });

  it("checks out pages-release in every trusted ci-control sparse list", () => {
    const pagesRelease = [
      "/scripts/release/pages-release.mjs",
      "/scripts/lib/pages-release.mjs",
    ];
    for (const name of [
      "bridge-untrusted",
      "pages-untrusted",
      "accept-bridge",
      "native-untrusted",
      "manifest",
    ]) {
      const control = producer.jobs[name].steps.find(
        (step) => step.with?.path === ".ci-control",
      );
      const lines = control.with["sparse-checkout"]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(control.with["sparse-checkout-cone-mode"], name).toBe(false);
      expect(lines, name).toEqual(
        expect.arrayContaining([
          ".github/workflows",
          "scripts/release",
          "scripts/lib",
          ...pagesRelease,
        ]),
      );
    }
    const native = producer.jobs["native-untrusted"].steps.find(
      (step) => step.with?.path === ".ci-control",
    );
    expect(native.with["sparse-checkout"].split("\n")).toContain("scripts/ci");
  });

  it("restores pages-untrusted helpers to the workspace ci-control directory", () => {
    const pages = producer.jobs["pages-untrusted"];
    expect(pages.defaults.run["working-directory"]).toBe("src");
    const park = pages.steps.find((step) =>
      step.name?.startsWith("Park trusted helpers"),
    );
    expect(park["working-directory"]).toBe("${{ github.workspace }}");
    expect(park.run).toBe('mv .ci-control "$RUNNER_TEMP/ci-control"');
    const restore = pages.steps.find((step) =>
      step.name?.startsWith("Restore trusted helpers"),
    );
    expect(restore.run).toBe(
      'mv "$RUNNER_TEMP/ci-control" "$GITHUB_WORKSPACE/.ci-control"',
    );
    expect(jobScripts(pages)).toContain(
      'node ../.ci-control/scripts/release/pages-release.mjs stamp apps/pages/dist "$SOURCE_SHA"',
    );
    const bridge = producer.jobs["bridge-untrusted"].steps.find((step) =>
      step.name?.startsWith("Restore trusted helpers"),
    );
    expect(bridge.run).toBe(restore.run);
  });
});

it("the candidate builder prepares Linux DBus through trusted rootless helpers before compiling the kit", () => {
  const native = producer.jobs["native-untrusted"];
  const control = native.steps.find(
    (step) => step.with?.path === ".ci-control",
  );
  expect(control.with["sparse-checkout"]).toContain("scripts/ci");
  const body = jobScripts(native);
  expect(body).toContain(
    'bash ../.ci-control/scripts/ci/prepare-dbus.sh "$RUNNER_TEMP/opensesame-dbus"',
  );
  expect(
    body.indexOf('source "$RUNNER_TEMP/opensesame-dbus/env.sh"'),
  ).toBeLessThan(body.indexOf("cargo build --locked --release"));
  expect(body).not.toMatch(/sudo|apt-get install/);
});
