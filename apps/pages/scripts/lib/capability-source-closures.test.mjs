import assert from "node:assert/strict";
import { test } from "vitest";
import { baseGraph, chunk, mod } from "./capability-fixtures.mjs";
import { violations } from "./capability-invariants.mjs";
import { lazyLeafChunk } from "./capability-lazy-leaves.mjs";
import { capabilitySourceClosures } from "./capability-source-closures.mjs";

const table = "\0virtual:opensesame-capability-modules";
const root = "apps/pages/src/modules/sharing.live/runtime.ts";
const allowed = "packages/app-core/src/lib/shared-identity-proof.ts";
const foreign = "apps/pages/src/modules/identity.local-iam/runtime.ts";
const owners = new Map([
  [root, ["optional", "sharing.live"]],
  [allowed, ["optional", "identity.local-iam"]],
  [foreign, ["optional", "identity.local-iam"]],
]);
const classify = (id) => {
  const [classification, capability] = owners.get(id) ?? ["core", null];
  return { id, classification, capability };
};

test("identity authorization UI stays separate from shared pairing crypto", () => {
  const entry = {
    classification: "optional",
    capability: "identity.local-iam",
  };
  for (const name of [
    "cli-authorize-panel",
    "cli-authorize-panel-model",
    "cli-authorize-pairing-form",
    "cli-authorize-pairing-form-model",
    "cli-authorize-paired-panel",
    "cli-authorize-mint-proof",
  ]) {
    assert.equal(
      lazyLeafChunk(
        `/workspace/apps/pages/src/modules/identity.local-iam/${name}.tsx`,
        entry,
      ),
      "cli-app-integration-ui",
    );
  }
});

test("source closures allow transitive static imports, never dynamic imports", () => {
  const info = new Map([
    [table, { dynamicallyImportedIds: [root] }],
    [root, { importedIds: ["helper"], dynamicallyImportedIds: [foreign] }],
    ["helper", { importedIds: [allowed], dynamicallyImportedIds: [] }],
    [allowed, { importedIds: [], dynamicallyImportedIds: [] }],
    [foreign, { importedIds: [], dynamicallyImportedIds: [] }],
  ]);
  assert.deepEqual(
    capabilitySourceClosures({ getModuleInfo: (id) => info.get(id) }, classify),
    [{ module: root, capability: "sharing.live", allowed: [allowed] }],
  );
});

test("a table root permits its real shared imports but rejects grouped foreign code", () => {
  const graph = baseGraph(
    [
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        isEntry: true,
      }),
      chunk("assets/live.js", [mod(root, "optional", "sharing.live")], {
        imports: ["assets/shared.js"],
      }),
      chunk("assets/shared.js", [
        mod(allowed, "optional", "identity.local-iam"),
      ]),
    ],
    {
      capabilitySourceClosures: [
        { module: root, capability: "sharing.live", allowed: [allowed] },
      ],
      moduleEdges: [
        {
          from: "virtual:opensesame-capability-modules",
          to: root,
          toCapability: "sharing.live",
          kind: "dynamic",
          viaTable: true,
        },
      ],
    },
  );
  const errors = () =>
    violations(
      graph,
      new Set(["sharing.live", "identity.local-iam"]),
      "selective",
    ).filter((entry) => entry.severity === "error");
  assert.deepEqual(errors(), []);
  graph.chunks[2].modules.push(mod(foreign, "optional", "identity.local-iam"));
  const [leak] = errors();
  assert.equal(leak.code, "CAPABILITY_STATIC_FOREIGN_OPTIONAL");
  assert.equal(leak.module, foreign);
  assert.deepEqual(leak.path, ["assets/live.js", "assets/shared.js"]);
});

test("a lazy facade is checked and an absent source closure fails closed", () => {
  const graph = baseGraph(
    [
      chunk("assets/main.js", [mod("apps/pages/src/main.tsx", "core")], {
        isEntry: true,
      }),
      chunk("assets/live.js", [mod(root, "optional", "sharing.live")]),
      {
        ...chunk("assets/live-facade.js", [], {
          imports: ["assets/identity.js"],
        }),
        facadeModuleId: root,
      },
      chunk("assets/identity.js", [
        mod(foreign, "optional", "identity.local-iam"),
      ]),
    ],
    {
      capabilitySourceClosures: [
        { module: root, capability: "sharing.live", allowed: [] },
      ],
      moduleEdges: [
        {
          from: table.slice(1),
          to: root,
          toCapability: "sharing.live",
          kind: "dynamic",
          viaTable: true,
        },
      ],
    },
  );
  const errors = () =>
    violations(graph, new Set(), "selective").filter(
      (entry) => entry.severity === "error",
    );
  assert.deepEqual(errors()[0].path, [
    "assets/live-facade.js",
    "assets/identity.js",
  ]);
  Reflect.deleteProperty(graph, "capabilitySourceClosures");
  assert.equal(errors()[0].code, "MISSING_CAPABILITY_SOURCE_CLOSURES");
});
