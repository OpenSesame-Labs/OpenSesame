import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { verifyDist } from "./verify-capability-graph.mjs";

const root = "apps/pages/src/modules/sharing.live/runtime.ts";
const allowed = "packages/app-core/src/lib/shared-identity-proof.ts";
const foreign = "apps/pages/src/modules/identity.local-iam/runtime.ts";
const mod = (id, capability) => ({
  id,
  classification: "optional",
  capability,
  rationale: "fixture",
  size: 1,
});
const chunk = (file, imports, dynamicImports, modules) => ({
  file,
  name: file,
  isEntry: file === "main.js",
  isDynamicEntry: file === "live.js",
  imports,
  dynamicImports,
  importedCss: [],
  importedAssets: [],
  modules,
});

async function check(grouped) {
  const dist = mkdtempSync(join(tmpdir(), "capability-lazy-closure-"));
  try {
    const graph = {
      distributionId: "dist:fixture",
      mode: "selective",
      profile: "fixture",
      coreCapabilities: [],
      entries: [
        {
          html: "index.html",
          capability: null,
          scripts: ["main.js"],
          preloads: [],
        },
      ],
      chunks: [
        chunk("main.js", [], ["live.js"], []),
        chunk("live.js", ["shared.js"], [], [mod(root, "sharing.live")]),
        chunk(
          "shared.js",
          [],
          [],
          [
            mod(allowed, "identity.local-iam"),
            ...(grouped ? [mod(foreign, "identity.local-iam")] : []),
          ],
        ),
      ],
      assets: [],
      workers: [],
      publicFiles: [],
      unclassified: [],
      moduleEdges: [
        {
          from: "virtual:opensesame-capability-modules",
          to: root,
          toCapability: "sharing.live",
          kind: "dynamic",
          viaTable: true,
        },
      ],
      capabilitySourceClosures: [
        { module: root, capability: "sharing.live", allowed: [allowed] },
      ],
    };
    const distribution = {
      distributionId: graph.distributionId,
      capabilityIds: ["sharing.live", "identity.local-iam"],
      moduleIds: ["sharing.live/runtime"],
      basePath: "/",
    };
    const files = {
      "index.html": '<script type="module" src="/main.js"></script>',
      "main.js": 'export const load=()=>import("./live.js");',
      "live.js": 'import "./shared.js"; export const runtime={};',
      "shared.js": "export const proof=1;",
      "capability-graph.json": JSON.stringify(graph),
      "capability-distribution.json": JSON.stringify(distribution),
    };
    for (const [file, content] of Object.entries(files))
      writeFileSync(join(dist, file), content);
    return (await verifyDist({ dist })).report;
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test("disk verification detects an extra foreign module in a shared lazy chunk", async () => {
  const legitimate = await check(false);
  assert.equal(legitimate.ok, true);
  const grouped = await check(true);
  assert.equal(grouped.ok, false);
  const finding = grouped.violations.find(
    (item) => item.code === "CAPABILITY_STATIC_FOREIGN_OPTIONAL",
  );
  assert.equal(finding?.module, foreign);
  assert.equal(finding?.entry, root);
  assert.deepEqual(finding?.path, ["live.js", "shared.js"]);
});
