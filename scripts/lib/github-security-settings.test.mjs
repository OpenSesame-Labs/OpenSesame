import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allowedActionPatterns,
  normalizeLive,
  settingsDrift,
  settingsWrites,
} from "./github-security-settings.mjs";
import { externalActionPaths, loadActionsFiles } from "./workflow-security.mjs";

const root = new URL("../../", import.meta.url);
const { $comment: _comment, ...expected } = JSON.parse(
  readFileSync(new URL("ops/github/repository-security.json", root), "utf8"),
);

/** API responses for a repository that already matches the declaration. */
function conformant() {
  return {
    repo: {
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
        dependabot_security_updates: { status: "enabled" },
        secret_scanning_validity_checks: { status: "disabled" },
      },
    },
    vulnerabilityAlerts: true,
    privateReporting: { enabled: true },
    immutableReleases: { enabled: true, enforced_by_owner: false },
    permissions: {
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: true,
      selected_actions_url: "https://api.github.example/selected-actions",
    },
    selectedActions: {
      github_owned_allowed: false,
      verified_allowed: false,
      patterns_allowed: [
        ...expected.actions.selected_actions.patterns_allowed,
      ].reverse(),
    },
    workflow: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
    forkApproval: { approval_policy: "all_external_contributors" },
  };
}

const driftFor = (mutate) => {
  const responses = conformant();
  mutate(responses);
  return settingsDrift(expected, normalizeLive(expected, responses));
};

describe("declared repository security settings", () => {
  it("turn on scanning, push protection, private reporting and immutable releases", () => {
    expect(expected.security_and_analysis).toEqual({
      secret_scanning: "enabled",
      secret_scanning_push_protection: "enabled",
      dependabot_security_updates: "enabled",
    });
    expect(expected.vulnerability_alerts).toBe(true);
    expect(expected.private_vulnerability_reporting).toBe(true);
    expect(expected.immutable_releases).toBe(true);
  });

  it("restrict Actions to pinned, listed actions with a read-only token", () => {
    expect(expected.actions.permissions).toEqual({
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: true,
    });
    expect(expected.actions.workflow).toEqual({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    });
    expect(expected.actions.fork_pr_contributor_approval).toEqual({
      approval_policy: "all_external_contributors",
    });
    expect(expected.actions.selected_actions.github_owned_allowed).toBe(false);
    expect(expected.actions.selected_actions.verified_allowed).toBe(false);
  });

  it("allow exactly the actions the workflows use, each by its full path", () => {
    // A new action is a reviewed change to this list in the same pull
    // request; a removed one leaves no standing permission behind.
    const used = loadActionsFiles(root).flatMap((file) =>
      externalActionPaths(file.text),
    );
    expect(expected.actions.selected_actions.patterns_allowed).toEqual(
      allowedActionPatterns(used),
    );
  });
});

describe("action paths", () => {
  it("keep an action's subdirectory, so the allow-list names what runs", () => {
    const text = [
      "      - uses: actions/cache/restore@0000000000000000000000000000000000000000",
      "      - uses: actions/checkout@1111111111111111111111111111111111111111 # v5",
      "    uses: octo/shared/.github/workflows/build.yml@2222222222222222222222222222222222222222",
      "      - uses: ./.github/actions/local",
    ].join("\n");
    expect(externalActionPaths(text)).toEqual([
      "actions/cache/restore",
      "actions/checkout",
      "octo/shared/.github/workflows/build.yml",
    ]);
    expect(allowedActionPatterns(externalActionPaths(text))).toEqual([
      "actions/cache/restore@*",
      "actions/checkout@*",
      "octo/shared/.github/workflows/build.yml@*",
    ]);
  });
});

describe("drift detection", () => {
  it("reports nothing for a conformant repository, whatever the list order", () => {
    expect(driftFor(() => {})).toEqual([]);
  });

  it("names each setting that differs and what it should be", () => {
    expect(
      driftFor((live) => {
        live.repo.security_and_analysis.secret_scanning_push_protection.status =
          "disabled";
      }),
    ).toEqual([
      {
        setting: "security_and_analysis.secret_scanning_push_protection",
        expected: "enabled",
        actual: "disabled",
      },
    ]);
    expect(
      driftFor((live) => {
        live.workflow.default_workflow_permissions = "write";
        live.permissions.sha_pinning_required = false;
      }).map((entry) => entry.setting),
    ).toEqual([
      "actions.permissions.sha_pinning_required",
      "actions.workflow.default_workflow_permissions",
    ]);
    expect(
      driftFor((live) => {
        live.selectedActions.patterns_allowed.push("evil/action@*");
      }).map((entry) => entry.setting),
    ).toEqual(["actions.selected_actions.patterns_allowed"]);
  });

  it("treats a missing or unreadable setting as drift, never as conformant", () => {
    expect(
      driftFor((live) => {
        delete live.repo.security_and_analysis;
        live.vulnerabilityAlerts = false;
        live.privateReporting = null;
        live.immutableReleases = { enabled: false };
      }).map((entry) => entry.setting),
    ).toEqual([
      "security_and_analysis.secret_scanning",
      "security_and_analysis.secret_scanning_push_protection",
      "security_and_analysis.dependabot_security_updates",
      "vulnerability_alerts",
      "private_vulnerability_reporting",
      "immutable_releases",
    ]);
  });
});

describe("planned writes", () => {
  it("sets the policy before the allow-list when Actions is unrestricted", () => {
    // The allow-list endpoint refuses to answer unless the policy is already
    // `selected`, so an unrestricted repository reports no list at all.
    const drift = driftFor((live) => {
      live.permissions.allowed_actions = "all";
      live.selectedActions = undefined;
    });
    expect(drift.map((entry) => entry.setting)).toEqual([
      "actions.permissions.allowed_actions",
      "actions.selected_actions.github_owned_allowed",
      "actions.selected_actions.verified_allowed",
      "actions.selected_actions.patterns_allowed",
    ]);
    expect(settingsWrites(expected, drift)).toEqual([
      {
        method: "PUT",
        path: "actions/permissions",
        body: expected.actions.permissions,
      },
      {
        method: "PUT",
        path: "actions/permissions/selected-actions",
        body: expected.actions.selected_actions,
      },
    ]);
  });

  it("turns vulnerability alerts on before Dependabot security updates", () => {
    // GitHub refuses security updates while alerts are off, so a repository
    // with both drifted must get the alerts first.
    const drift = driftFor((live) => {
      live.vulnerabilityAlerts = false;
      live.repo.security_and_analysis.dependabot_security_updates.status =
        "disabled";
    });
    const paths = settingsWrites(expected, drift).map(({ path }) => path);
    expect(paths.indexOf("vulnerability-alerts")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("vulnerability-alerts")).toBeLessThan(
      paths.indexOf(""),
    );
  });

  it("writes nothing when nothing drifted", () => {
    expect(settingsWrites(expected, [])).toEqual([]);
  });

  it("writes only the drifted sections, each to its own endpoint", () => {
    const drift = driftFor((live) => {
      live.repo.security_and_analysis.secret_scanning.status = "disabled";
      live.immutableReleases = { enabled: false };
      live.selectedActions.verified_allowed = true;
    });
    expect(settingsWrites(expected, drift)).toEqual([
      { method: "PUT", path: "immutable-releases" },
      {
        method: "PATCH",
        path: "",
        body: {
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
            dependabot_security_updates: { status: "enabled" },
          },
        },
      },
      {
        method: "PUT",
        path: "actions/permissions/selected-actions",
        body: expected.actions.selected_actions,
      },
    ]);
  });
});
