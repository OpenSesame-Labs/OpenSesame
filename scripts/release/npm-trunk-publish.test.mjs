import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyNpmPublishResult,
  isForbiddenRepublishOfVersion,
  npmTrunkPublish,
} from "./npm-trunk-publish.mjs";

const version = "0.0.0-alpha.23";
const forbidden = `npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@opensesame-labs%2fcli - You cannot publish over the previously published versions: 0.0.0-alpha.23.`;

test("isForbiddenRepublishOfVersion matches trunk CD 403 body", () => {
  assert.equal(isForbiddenRepublishOfVersion(forbidden, version), true);
  assert.equal(
    isForbiddenRepublishOfVersion(forbidden, "0.0.0-alpha.24"),
    false,
  );
  assert.equal(isForbiddenRepublishOfVersion("npm error 404", version), false);
});

test("classifyNpmPublishResult maps E403 republish to already_published", () => {
  assert.equal(
    classifyNpmPublishResult(
      { status: 1, stdout: "", stderr: forbidden },
      version,
    ),
    "already_published",
  );
  assert.equal(
    classifyNpmPublishResult({ status: 0, stdout: "", stderr: "" }, version),
    "published",
  );
  assert.equal(
    classifyNpmPublishResult(
      { status: 1, stdout: "", stderr: "npm error 401" },
      version,
    ),
    "failed",
  );
});

const input = {
  packageName: "@opensesame-labs/cli",
  version,
  distTag: "alpha",
  cwd: ".",
};

test("a 403 republish is confirmed even when the registry's read side lags", () => {
  // The incident: the view missed, the publish was refused as a republish.
  // The first views after the 403 can miss for the same reason.
  const views = [undefined, undefined, undefined, version];
  const waits = [];
  const result = npmTrunkPublish(input, {
    view: () => views.shift(),
    publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
    wait: (ms) => waits.push(ms),
  });
  assert.equal(result.outcome, "already_published");
  assert.equal(result.confirmAfter403, version);
  assert.equal(waits.length, 2);
  assert.equal(views.length, 0);
});

test("a 403 the registry never confirms is a failure, not a success", () => {
  let asked = 0;
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => {
          asked += 1;
          return undefined;
        },
        publish: () => ({ status: 1, stdout: "", stderr: forbidden }),
        wait: () => {},
      }),
    /already published but registry view got missing/,
  );
  // One view before the publish, then a bounded number after it.
  assert.equal(asked, 7);
});

test("a version already on the registry is never published again", () => {
  let published = 0;
  const result = npmTrunkPublish(input, {
    view: () => version,
    publish: () => {
      published += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    wait: () => {},
  });
  assert.equal(result.outcome, "already_published");
  assert.equal(published, 0);
});

test("any other publish failure still fails", () => {
  assert.throws(
    () =>
      npmTrunkPublish(input, {
        view: () => undefined,
        publish: () => ({ status: 1, stdout: "", stderr: "npm error 401" }),
        wait: () => {},
      }),
    /npm error 401/,
  );
});
