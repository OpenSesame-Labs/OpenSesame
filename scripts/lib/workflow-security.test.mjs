import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  executableBodies,
  loadActionsFiles,
  unpinnedUses,
  untrustedInterpolations,
  workflowFindings,
} from "./workflow-security.mjs";

const root = new URL("../../", import.meta.url);
const files = loadActionsFiles(root);
const workflows = files.filter((file) => file.kind === "workflow");

describe("checked-in workflows", () => {
  it("finds the workflows and the composite action", () => {
    expect(workflows.length).toBeGreaterThan(30);
    expect(files.some((file) => file.kind === "action")).toBe(true);
  });

  it("grant nothing at workflow level and declare permissions per job", () => {
    for (const { name, doc } of workflows)
      expect(workflowFindings(doc), name).toEqual([]);
  });

  it("pin every external action in workflows and composite actions", () => {
    for (const { name, text } of files)
      expect(unpinnedUses(text), name).toEqual([]);
  });

  it("never interpolate untrusted input into a composite action body", () => {
    for (const { name, doc } of files.filter((file) => file.kind === "action"))
      for (const body of executableBodies(doc))
        expect(untrustedInterpolations(body.text), name).toEqual([]);
  });

  it("reach the self-hosted runner only through the owner-only guard", () => {
    // This repository is public. A self-hosted runner executes whatever a
    // pull request contains, so the label may appear only where the guard
    // admits the owner's own same-repository branches.
    const users = workflows.filter(({ text }) => text.includes("self-hosted"));
    expect(users.map(({ name }) => name).sort()).toEqual([
      "ci-prerelease-checks.yml",
      "ci.yml",
    ]);
    for (const { name, text } of users) {
      expect(text, name).toContain('[ "$ACTOR" = "$OWNER" ]');
      expect(text, name).toContain('[ "$HEAD_REPO" = "$REPO" ]');
      expect(text, name).toContain('[ "$ENABLED" = "true" ]');
    }
  });
});

const conforming = `
on:
  pull_request:
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo "$TITLE"
        env:
          TITLE: \${{ github.event.pull_request.title }}
`;

function findingsFor(mutate) {
  const doc = parse(conforming);
  mutate(doc);
  return workflowFindings(doc);
}

describe("negative controls: permissions and triggers", () => {
  it("accepts untrusted input that arrives through env", () => {
    expect(workflowFindings(parse(conforming))).toEqual([]);
  });

  it("rejects inherited, blanket and workflow-level permissions", () => {
    expect(
      findingsFor((doc) => {
        doc.permissions = { contents: "read" };
      }),
    ).toEqual(["workflow-level permissions must be exactly {}"]);
    expect(
      findingsFor((doc) => {
        delete doc.permissions;
      }),
    ).toEqual(["workflow-level permissions must be exactly {}"]);
    expect(
      findingsFor((doc) => {
        delete doc.jobs.build.permissions;
      }),
    ).toEqual(["job build declares no permissions"]);
    expect(
      findingsFor((doc) => {
        doc.jobs.build.permissions = "write-all";
      }),
    ).toEqual(["job build uses the blanket write-all grant"]);
  });

  it("rejects pull_request_target and an unfiltered workflow_run", () => {
    expect(
      findingsFor((doc) => {
        doc.on = { pull_request_target: null };
      }),
    ).toEqual(["uses the privileged pull_request_target trigger"]);
    expect(
      findingsFor((doc) => {
        doc.on = ["pull_request_target"];
      }),
    ).toEqual(["uses the privileged pull_request_target trigger"]);
    expect(
      findingsFor((doc) => {
        doc.on = { workflow_run: { workflows: ["CI"], types: ["completed"] } };
      }),
    ).toEqual(["workflow_run has no branches filter"]);
    expect(
      findingsFor((doc) => {
        doc.on = { workflow_run: { workflows: ["CI"], branches: ["main"] } };
      }),
    ).toEqual([]);
  });
});

describe("negative controls: script injection and pinning", () => {
  it("rejects untrusted input interpolated into a shell or script body", () => {
    const expressions = [
      "github.event.pull_request.title",
      "github.event.issue.body",
      "github.event.comment.body",
      "github.event.pull_request.head.ref",
      "github.event.head_commit.message",
      "github.event.commits[0].author.email",
      "github.event.workflow_run.head_branch",
      "github.head_ref",
      "github.ref_name",
      "inputs.tag",
      "github.event.inputs.tag",
    ];
    for (const expression of expressions) {
      expect(
        findingsFor((doc) => {
          doc.jobs.build.steps[0].run = `echo "\${{ ${expression} }}"`;
        }),
        expression,
      ).toEqual([`job build step 1 interpolates untrusted ${expression}`]);
    }
    expect(
      findingsFor((doc) => {
        doc.jobs.build.steps[0].with = {
          script: "core.info(`${{ github.event.issue.title }}`)",
        };
      }),
    ).toEqual([
      "job build step 1 interpolates untrusted github.event.issue.title",
    ]);
  });

  it("accepts the trusted contexts the workflows interpolate today", () => {
    const trusted = [
      "matrix.file",
      "needs.changes.result",
      "steps.push.outputs.digest",
      "runner.temp",
      "github.sha",
      "github.event.pull_request.number",
      "github.event.pull_request.head.sha",
      "github.event.workflow_run.head_sha",
    ];
    for (const expression of trusted)
      expect(untrustedInterpolations(`\${{ ${expression} }}`)).toEqual([]);
  });

  it("rejects a tag, a branch and a short SHA as an action pin", () => {
    expect(unpinnedUses("      - uses: actions/checkout@v5")).toEqual([
      "actions/checkout@v5",
    ]);
    expect(
      unpinnedUses("    uses: org/repo/.github/workflows/x.yml@main"),
    ).toEqual(["org/repo/.github/workflows/x.yml@main"]);
    expect(unpinnedUses("      - uses: actions/checkout@fbc6f39")).toEqual([
      "actions/checkout@fbc6f39",
    ]);
    expect(
      unpinnedUses(
        "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0\n    uses: ./.github/workflows/local.yml",
      ),
    ).toEqual([]);
  });
});
