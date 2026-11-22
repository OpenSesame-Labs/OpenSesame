import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { CompilerErrorCodeSchema } from "./evidence.js";
import {
  type CompilerCatalog,
  type CompilerErrorCode,
  PolicyDocumentSchema,
  SCENARIO_IDS,
  compileDuressPolicy,
  importDuressPolicyPreview,
  roundTripDuressPolicy,
} from "./index.js";
import { INVALID_FIXTURES } from "./invalid-fixtures.js";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "testdata");
const REPO_ROOT = resolve(EXAMPLES, "../../../../..");

/**
 * `testdata/invalid.json` maps every compiler error code to its document and
 * is generated from `INVALID_FIXTURES`. A normal run only compares the
 * checked-in bundle with it and fails on drift; the flag rewrites it,
 * formatted by the repository's Biome so the output is byte-for-byte what
 * `npm run lint` accepts:
 *
 *   UPDATE_DURESS_FIXTURES=1 npm exec -w @opensesame/contracts -- \
 *     vitest run src/duress/fixtures.test.ts
 */
const UPDATE = process.env.UPDATE_DURESS_FIXTURES !== undefined;

const INVALID_BUNDLE = join(EXAMPLES, "invalid.json");

const invalidBundleText = () =>
  `${JSON.stringify(
    Object.fromEntries(
      CompilerErrorCodeSchema.options.map((code) => [
        code,
        INVALID_FIXTURES[code],
      ]),
    ),
    null,
    2,
  )}\n`;

/** `testdata/scenarios.{json,yaml}` each map a scenario id to its policy. */
const readExample = (name: string) =>
  readFileSync(join(EXAMPLES, name), "utf8");
const ScenarioBundleSchema = z.record(z.string(), PolicyDocumentSchema);
const SCENARIOS_JSON = ScenarioBundleSchema.parse(
  JSON.parse(readExample("scenarios.json")),
);
const SCENARIOS_YAML = ScenarioBundleSchema.parse(
  parseYaml(readExample("scenarios.yaml")),
);

const catalog: CompilerCatalog = {
  ownerPrincipalRefs: ["owner-1"],
  organizationRefs: ["org-1"],
  vaultRefs: ["vault-1"],
  deviceBindingRefs: ["device-1", "device-retired"],
  compartmentRefs: [
    "comp-normal",
    "comp-decoy",
    "comp-restricted",
    "comp-carry",
  ],
  independentCompartmentRefs: ["comp-decoy", "comp-restricted", "comp-carry"],
  routeRefs: ["route-alert-1"],
  peerRefs: ["peer-1"],
  providerActionRefs: [],
  recoveryPolicyRefs: ["recovery-1", "recovery-cycle-a", "recovery-cycle-b"],
  operationCeilingRefs: ["ceiling-restricted", "ceiling-carry"],
  authorityRefs: ["host-authority-1"],
  durableStorage: true,
  alternateUnlockPaths: [],
  retiredDeviceBindingRefs: ["device-retired"],
  recoveryEdges: [
    {
      fromPolicyRef: "recovery-cycle-a",
      dependsOnPolicyRef: "recovery-cycle-b",
    },
    {
      fromPolicyRef: "recovery-cycle-b",
      dependsOnPolicyRef: "recovery-cycle-a",
    },
  ],
};

beforeAll(() => {
  if (!UPDATE) return;
  writeFileSync(INVALID_BUNDLE, invalidBundleText());
  execFileSync(
    "npm",
    ["exec", "--", "biome", "format", "--write", INVALID_BUNDLE],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
});

describe("scenario fixtures", () => {
  it.each([...SCENARIO_IDS])("%s validates and compiles", (id) => {
    const doc = SCENARIOS_JSON[id];
    expect(doc, id).toBeDefined();
    if (!doc) return;
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.armed).toBe(false);
    const yamlRound = roundTripDuressPolicy(doc, "yaml");
    const jsonRound = roundTripDuressPolicy(doc, "json");
    expect(yamlRound.policyId).toBe(doc.policyId);
    expect(jsonRound.revision).toBe(doc.revision);
  });
});

describe("invalid fixtures", () => {
  it.each(CompilerErrorCodeSchema.options)(
    "rejects with %s",
    (code: CompilerErrorCode) => {
      const document = INVALID_FIXTURES[code];
      expect(document).toBeDefined();

      let cat: CompilerCatalog = { ...catalog };
      if (code === "stale_policy") {
        cat = { ...cat, minPolicyRevision: 99 };
      }
      if (code === "stale_session") {
        cat = {
          ...cat,
          expectedSessionDigest: "sha256:aaaaaaaaaaaaaaaa",
          presentedSessionDigest: "sha256:bbbbbbbbbbbbbbbb",
        };
      }
      if (code === "alternate_unlock_bypass") {
        cat = {
          ...cat,
          alternateUnlockPaths: [
            { label: "legacy-password", bypassesClaim: true },
          ],
        };
      }
      if (code === "undurable_storage") {
        cat = { ...cat, durableStorage: false };
      }

      const result = compileDuressPolicy(document, cat);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.diagnostics.some((d) => d.code === code),
          JSON.stringify(result.diagnostics),
        ).toBe(true);
      }
    },
  );
});

describe("import preview", () => {
  it("strips secrets and never arms", () => {
    const yaml = stringifyYaml(SCENARIOS_YAML["SC-ALERT-ONLY"]);
    const poisoned = `${yaml}\ntriggerSecret: hunter2\n`;
    const preview = importDuressPolicyPreview(poisoned, "yaml", catalog);
    expect(preview.armed).toBe(false);
    expect(preview.cleared).toBe(false);
    expect(preview.strippedSecretKeys).toContain("triggerSecret");
    expect(preview.dryRun.wouldArm).toBe(false);
  });
});

describe("examples directory coverage", () => {
  it("has yaml+json for every scenario, and they agree", () => {
    expect(Object.keys(SCENARIOS_JSON).sort()).toEqual(
      [...SCENARIO_IDS].sort(),
    );
    expect(Object.keys(SCENARIOS_YAML).sort()).toEqual(
      [...SCENARIO_IDS].sort(),
    );
    for (const id of SCENARIO_IDS) {
      expect(SCENARIOS_YAML[id], id).toEqual(SCENARIOS_JSON[id]);
    }
    // The raw documents agree too, before any schema parsing.
    expect(parseYaml(readExample("scenarios.yaml"))).toEqual(
      JSON.parse(readExample("scenarios.json")),
    );
  });

  it.each(CompilerErrorCodeSchema.options)(
    "invalid.json %s matches INVALID_FIXTURES",
    (code: CompilerErrorCode) => {
      const hint = `${INVALID_BUNDLE} is stale; rerun with UPDATE_DURESS_FIXTURES=1`;
      const bundle = JSON.parse(readFileSync(INVALID_BUNDLE, "utf8"));
      expect(Object.keys(bundle).sort(), hint).toEqual(
        [...CompilerErrorCodeSchema.options].sort(),
      );
      expect(bundle[code], hint).toEqual(JSON.parse(invalidBundleText())[code]);
    },
  );
});
