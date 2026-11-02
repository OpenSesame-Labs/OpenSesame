import assert from "node:assert/strict";
import { test } from "node:test";
import { runPreviewSmoke } from "./cd-preview-smoke.mjs";
import { notifyPromotionBlocked } from "./cd-promotion-notify.mjs";

test("preview smoke simulated mode skips registry without force-fail", async () => {
  await runPreviewSmoke(
    { CD_PREVIEW_SMOKE_SIMULATED: "1", NPM_DIST_TAG: "alpha" },
    {},
  );
});

test("preview smoke honors force-fail for proof workflows", async () => {
  await assert.rejects(
    () =>
      runPreviewSmoke(
        { CD_PREVIEW_SMOKE_FORCE_FAIL: "1", NPM_DIST_TAG: "alpha" },
        {},
      ),
    /forced to fail/,
  );
});

test("notifyPromotionBlocked posts a commit comment", async () => {
  let posted = "";
  await notifyPromotionBlocked(
    {
      GITHUB_TOKEN: "token",
      GITHUB_SHA: "b".repeat(40),
      GITHUB_REPOSITORY: "OpenSesame-Labs/OpenSesame",
      PROMOTION_FAIL_REASON: "preview smoke failed",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "42",
    },
    {
      fetch: async (_url, init) => {
        posted = init?.body ?? "";
        return { ok: true, json: async () => ({}) };
      },
    },
  );
  assert.match(posted, /preview smoke failed/);
  assert.match(posted, /actions\/runs\/42/);
});
