import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLiveSmokeEvidence } from "./screenshot-evidence.mjs";

test("captureLiveSmokeEvidence requires evidence output directory", async () => {
  await assert.rejects(
    () =>
      captureLiveSmokeEvidence({
        PAGES_URL: "https://example.github.io/OpenSesame/",
        GITHUB_SHA: "a".repeat(40),
      }),
    /SMOKE_EVIDENCE_OUT is required/,
  );
});
