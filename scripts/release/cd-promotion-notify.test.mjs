import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotationCommand,
  failedGateNames,
  gatesFromEnv,
  notifyPromotionFailure,
  promotionMessage,
} from "./cd-promotion-notify.mjs";

const sha = "c".repeat(40);
const token = "ghp_test_token_not_a_secret_value";
const repository = "OpenSesame-Labs/OpenSesame";

function env(extra = {}) {
  return {
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW: "CD npm CLI",
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_URL: `https://github.com/${repository}/actions/runs/99`,
    GH_TOKEN: token,
    GATE_MAIN_CI: "success",
    GATE_PREVIEW_SMOKE: "failure",
    GATE_PRODUCTION: "skipped",
    ...extra,
  };
}

test("promotion message names the failed gate and the skipped followers", () => {
  const gates = gatesFromEnv(env());
  assert.deepEqual(failedGateNames(gates), ["preview_smoke"]);
  const message = promotionMessage(gates, env());
  assert.match(message, new RegExp(`CD promotion blocked on ${sha}`));
  assert.match(message, /Failed gate: preview_smoke/);
  assert.match(message, /Skipped after the failure: production/);
  assert.match(message, /Workflow: CD npm CLI/);
  assert.doesNotMatch(message, /ghp_test_token/);
  assert.match(annotationCommand(message), /^::error title=CD promotion blocked::/);
  assert.match(annotationCommand(message), /preview_smoke/);
  assert.throws(() => promotionMessage(gatesFromEnv({ GATE_MAIN_CI: "success" }), env()), /no failed gate/);
});

test("notify writes an annotation and comments on the commit", async () => {
  const lines = [];
  let posted = null;
  const message = await notifyPromotionFailure(env(), {
    emit: (line) => lines.push(line),
    fetch: async (url, options) => {
      posted = { url: String(url), options };
      return { ok: true, status: 201 };
    },
  });
  assert.match(lines[0], /^::error title=CD promotion blocked::/);
  assert.match(lines[0], /preview_smoke/);
  assert.equal(
    posted.url,
    `https://api.github.com/repos/${repository}/commits/${sha}/comments`,
  );
  assert.equal(posted.options.method, "POST");
  assert.match(posted.options.headers.Authorization, /^Bearer /);
  const body = JSON.parse(posted.options.body);
  assert.equal(body.body, message);
  assert.doesNotMatch(body.body, /ghp_test_token/);
  assert.equal(posted.options.headers.Authorization.includes(token), true);
});

test("dry run annotates and does not call GitHub", async () => {
  const lines = [];
  await notifyPromotionFailure(env({ CD_NOTIFY_DRY_RUN: "1", GH_TOKEN: "" }), {
    emit: (line) => lines.push(line),
    fetch: async () => {
      throw new Error("dry run must not post");
    },
  });
  assert.match(lines[0], /Failed gate/);
});

test("a missing token still annotates, then fails the comment", async () => {
  const lines = [];
  await assert.rejects(
    () =>
      notifyPromotionFailure(env({ GH_TOKEN: "", GITHUB_TOKEN: "" }), {
        emit: (line) => lines.push(line),
        fetch: async () => {
          throw new Error("must not post without a token");
        },
      }),
    /GH_TOKEN or GITHUB_TOKEN is required/,
  );
  assert.match(lines[0], /::error title=CD promotion blocked::/);
});

test("comment HTTP failures name the status and the contents permission", async () => {
  await assert.rejects(
    () =>
      notifyPromotionFailure(env(), {
        emit: () => {},
        fetch: async () => ({ ok: false, status: 403 }),
      }),
    /HTTP 403 \(contents: write is required\)/,
  );
});
