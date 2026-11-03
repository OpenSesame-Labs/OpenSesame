#!/usr/bin/env node
/**
 * Build the Full install-profile dist for CD promotion (capability-profiles/full.json).
 * Typecheck and trunk compile already ran in required main CI (TypeScript job).
 *
 *   node scripts/ci/pwa-full-profile-dist-build.mjs
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WALK_NAMES,
  appPaths,
  buildDist,
  resolveWalks,
} from "../../apps/pages/scripts/lib/verification-checklist-profiles.mjs";
import { FULL_INSTALL_PROFILE_PROOF_NAME } from "./pwa-profile-proof-select.mjs";

async function main() {
  const paths = appPaths();
  const resolved = resolveWalks(paths.profilesDir, WALK_NAMES);
  const full = resolved.find(
    (walk) => walk.name === FULL_INSTALL_PROFILE_PROOF_NAME,
  );
  if (!full) {
    throw new Error("full install profile walk missing");
  }
  const outDir = resolve(
    paths.appRoot,
    "dist-profiles",
    "pwa-proof",
    full.buildKey,
  );
  buildDist({
    appRoot: paths.appRoot,
    scriptsDir: paths.scriptsDir,
    outDir,
    capabilityProfile: full.capabilityProfile,
  });
  console.error(`[pwa-full-profile-dist] ready ${outDir}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
