import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkExploration,
  switchCoverage,
} from "../../apps/pages/scripts/lib/ui-property-trace.mjs";
import {
  checkModelDirectories,
  checkModels,
  discoverModels,
  validateJar,
} from "../../apps/pages/scripts/verify-ui-model.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/node_modules/", import.meta.url),
)("yaml");
const root = repoRootFromHere();
const workflow = parse(
  readFileSync(
    join(root, ".github/workflows/ci-prerelease-checks.yml"),
    "utf8",
  ),
);
const temporary = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "ui-model-test-"));
  temporary.push(path);
  return path;
}

function add(path, ...files) {
  for (const file of files) writeFileSync(join(path, file), "fixture");
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true });
});

describe("finite UI model runner", () => {
  it("refuses a missing or unreviewed TLC jar before running a model", () => {
    const path = directory();
    add(path, "unknown.jar");
    expect(() => validateJar(undefined)).toThrow(/TLA2TOOLS_JAR/);
    expect(() => validateJar(join(path, "unknown.jar"))).toThrow(
      /does not match/,
    );
  });

  it("refuses an empty directory and either kind of unpaired file", () => {
    const path = directory();
    expect(() => discoverModels(path)).toThrow(/at least one/);
    add(path, "A.tla", "A.cfg", "B.tla");
    expect(() => discoverModels(path)).toThrow(/Missing configuration for B/);
    add(path, "B.cfg", "C.cfg");
    expect(() => discoverModels(path)).toThrow(/Missing model for C/);
  });

  it("does not silently ignore a model path that is not a regular file", () => {
    const path = directory();
    add(path, "A.tla", "A.cfg");
    mkdirSync(join(path, "B.tla"));
    expect(() => discoverModels(path)).toThrow(/Expected a regular model file/);
  });

  it("checks every paired model and stops on a TLC failure", () => {
    const path = directory();
    add(path, "B.tla", "B.cfg", "A.tla", "A.cfg");
    expect(discoverModels(path)).toEqual(["A.tla", "B.tla"]);
    const run = vi.fn(() => ({ status: 0 }));
    checkModels(path, "/tools/reviewed.jar", "/tmp/tlc-meta", run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toContain("A.cfg");
    expect(run.mock.calls[1][1]).toContain("B.cfg");
    expect(run.mock.calls[0][2].cwd).toBe(path);

    run.mockReset().mockReturnValueOnce({ status: 1 });
    expect(() =>
      checkModels(path, "/tools/reviewed.jar", "/tmp/tlc-meta", run),
    ).toThrow(/TLC failed for A.tla/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("requires and checks every model domain", () => {
    const path = directory();
    const ui = join(path, "ui");
    const auth = join(path, "auth");
    mkdirSync(ui);
    mkdirSync(auth);
    add(ui, "Control.tla", "Control.cfg");
    add(auth, "Admission.tla", "Admission.cfg");
    const run = vi.fn(() => ({ status: 0 }));
    checkModelDirectories([ui, auth], "/tools/reviewed.jar", path, run);
    expect(run.mock.calls.map((call) => call[1].at(-1))).toEqual([
      "Control.tla",
      "Admission.tla",
    ]);
    rmSync(join(auth, "Admission.cfg"));
    expect(() =>
      checkModelDirectories([ui, auth], "/tools/reviewed.jar", path, run),
    ).toThrow();
    expect(() =>
      checkModelDirectories([], "/tools/reviewed.jar", path, run),
    ).toThrow(/No model directories/);
  });
});

describe("UI behavior qualifies each candidate", () => {
  it("runs the paired models, generated browser interactions and negative control before receipt", () => {
    const job = workflow.jobs["behavior-verification"];
    expect(job.needs).toBe("admission");
    expect(job.if).toBeUndefined();
    expect(job.env.CANDIDATE_REVISION).toBe("${{ inputs.source_sha }}");
    expect(workflow.jobs.gate.needs).toContain("behavior-verification");
    const steps = job.steps.map((step) => step.run ?? "").join("\n");
    expect(steps).toContain("npm ci --ignore-scripts");
    expect(steps).toContain("releases/download/v1.7.4/tla2tools.jar");
    expect(steps).toContain(
      "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
    );
    expect(steps).toContain("sha256sum --check");
    expect(steps).toContain("node --test scripts/formal/ledger.test.mjs");
    expect(steps).toContain("node scripts/formal/inventory.mjs --check");
    expect(
      steps.indexOf("node scripts/formal/inventory.mjs --check"),
    ).toBeLessThan(
      steps.indexOf("npm run verify:behavior-models -w @opensesame/pages"),
    );
    expect(steps).toContain(
      "npm run verify:behavior-models -w @opensesame/pages",
    );
    expect(steps).toContain("toast-model-fault.test.mjs");
    expect(steps).toContain("leanprover/lean4/releases/download/v4.24.0/");
    expect(steps).toContain(
      "b14f5e5159219dd1a1956c3b806813319f5e94ccd5bdfd56f54520609a5bb5ec",
    );
    expect(steps).toContain("node spec/auth-verification/verify.mjs");
    expect(steps).toContain(
      "node --test spec/auth-verification/verify.test.mjs",
    );
    expect(steps).toContain(
      "npm run verify:ui-properties -w @opensesame/pages",
    );
    expect(steps).toContain("-- --self-check");
    expect(steps).toContain("google-chrome --version");
    expect(JSON.stringify(job)).not.toContain("continue-on-error");
  });

  it("runs the implementation and accessibility regression suites", () => {
    const steps = workflow.jobs["behavior-verification"].steps
      .map((step) => step.run ?? "")
      .join("\n");
    const suites = [
      "transaction.auth-proof.properties.test.ts",
      "auth-admission.properties.test.ts",
      "authorization-request-finite.test.ts",
      "scripts/saml-browser-crypto.integration.test.mjs",
      "src/lib/capabilities/classification.test.ts",
      "src/lib/capabilities/classification-notification-ownership.test.ts",
      "src/browser/saml/assertion.test.ts",
      "src/browser/saml/admission.test.ts",
      "src/browser/saml/xml-crypto-certificate.test.ts",
      "src/lib/identity-saml-activation.test.ts",
      "src/lib/local-passkeys.test.ts",
      "src/lib/secret-backends/bitwarden-native-kdf.test.ts",
      "src/lib/duress/crypto/slot-secret-lifetime.test.ts",
      "src/lib/duress/crypto/slots.test.ts",
      "src/tutorial/registry/context.test.ts",
      "src/tutorial/registry/routes.test.ts",
      "src/egress-routes.test.ts",
      "AppShell.test.tsx",
      "InlineRecommendations.behavior.test.tsx",
      "NoticeCorner.test.tsx",
      "NoticeCorner.behavior.test.tsx",
      "Notices.test.tsx",
      "Recommender.test.tsx",
      "ToastStack.test.tsx",
      "ToastStack.reading.test.tsx",
      "ToastStack.offer.test.tsx",
      "notice-toast.test.ts",
      "recommendations.test.ts",
      "FirstVisitOffer.placement.test.tsx",
      "federation-pending.property.test.ts",
      "github-connection-lifecycle.property.test.ts",
      "vault-interaction.property.test.ts",
      "CapabilitySwitch.behavior.test.tsx",
      "ProviderTiles.test.tsx",
      "IntegrationSections.roads.test.tsx",
      "tutorial-route.property.test.tsx",
    ];
    for (const suite of suites) expect(steps).toContain(suite);
  });
});

describe("generated browser evidence", () => {
  it("rejects failures, empty explorations and undetected mutations", () => {
    expect(() =>
      checkExploration({ code: 0, sawClick: false }, "switch", 390, false),
    ).toThrow(/Bombadil failed/);
    expect(() =>
      checkExploration({ code: 1, sawClick: true }, "switch", 390, false),
    ).toThrow(/Bombadil failed/);
    expect(() =>
      checkExploration({ code: 1, sawViolation: false }, "switch", 390, true),
    ).toThrow(/mutation was not detected/);
    expect(() =>
      checkExploration({ code: 0, sawViolation: true }, "switch", 390, true),
    ).toThrow(/mutation was not detected/);
    expect(() =>
      checkExploration({ code: 1, sawViolation: true }, "switch", 390, true),
    ).not.toThrow();
  });

  it("requires accepted, rejected and disabled attempts in a normal trace", () => {
    const trace = (coverage) =>
      JSON.stringify({ snapshots: [{ name: "state", value: { coverage } }] });
    expect(() => switchCoverage("{}")).toThrow(/accepted/);
    expect(() =>
      switchCoverage(trace({ accepted: 1, rejected: 0, disabled: 1 })),
    ).toThrow(/rejected/);
    const covered = { accepted: 1, rejected: 2, disabled: 3 };
    expect(switchCoverage(trace(covered))).toEqual(covered);
  });
});
