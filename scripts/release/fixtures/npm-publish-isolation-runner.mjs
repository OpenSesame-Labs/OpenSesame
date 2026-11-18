import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createNpmContext } from "../npm-publish-isolation.mjs";
import { npmTrunkPublish, npmViewIntegrity } from "../npm-trunk-publish.mjs";
import {
  prepareNpmPublish,
  readPreparedPublish,
} from "../prepare-npm-publish.mjs";

const [packageDirectory, registry, mode] = process.argv.slice(2);
let root;
try {
  root = await prepareNpmPublish(
    packageDirectory,
    "alpha",
    "@opensesame-labs/cli",
  );
  const state = readPreparedPublish(root);
  const context = createNpmContext(
    mkdtempSync(join(root, "fixture-")),
    registry,
  );
  const observed = npmViewIntegrity(state.name, state.version, context);
  if (mode === "missing" || mode === "version-missing") {
    process.stdout.write(
      `RESULT ${JSON.stringify({ observed: observed ?? null })}\n`,
    );
  } else {
    let views = 0;
    let result;
    try {
      result = npmTrunkPublish(
        {
          packageName: state.name,
          version: state.version,
          distTag: state.tag,
          integrity: state.integrity,
          tarball: state.tarball,
          context,
        },
        {
          view: () => (++views === 1 ? undefined : state.integrity),
          wait: () => {},
        },
      );
    } catch (error) {
      // Our fake OIDC token is intentionally not valid for Sigstore, so real
      // provenance stops without publishing or making an external request.
      result = {
        outcome: "stopped",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(
      `RESULT ${JSON.stringify({ observed, integrity: state.integrity, result, mode })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (root) rmSync(root, { recursive: true, force: true });
}
