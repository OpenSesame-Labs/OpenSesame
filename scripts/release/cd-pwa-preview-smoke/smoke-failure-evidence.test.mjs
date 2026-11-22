import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bootstrapSmokeEvidence,
  redactDiagnosticText,
  writeSmokePhaseFailure,
} from "./smoke-failure-evidence.mjs";

const sha = "a".repeat(40);

test("redactDiagnosticText truncates and redacts bearer tokens", () => {
  const long = "x".repeat(600);
  assert.equal(redactDiagnosticText(long).length, 501);
  assert.match(
    redactDiagnosticText("Authorization Bearer abc.def.ghi"),
    /\[redacted\]/,
  );
  // The JSON value loses its content; the key must stay visible.
  const consoleJson = redactDiagnosticText('console error {"token":"abc"}');
  assert.equal(consoleJson, 'console error {"token":"[redacted]"}');
  assert.ok(!consoleJson.includes('{"[redacted]'));
  assert.equal(
    redactDiagnosticText('{"api_key":"sekret","password":"p"}'),
    '{"api_key":"[redacted]","password":"[redacted]"}',
  );
  assert.equal(
    redactDiagnosticText('{"access_token":"xyz","api-key":"k"}'),
    '{"access_token":"[redacted]","api-key":"[redacted]"}',
  );
  assert.equal(
    redactDiagnosticText("fetch failed for token=abc123 at /x"),
    "fetch failed for [redacted] at /x",
  );
});

test("bootstrapSmokeEvidence creates the output directory", async () => {
  const parent = mkdtempSync(join(tmpdir(), "smoke-bootstrap-parent-"));
  const out = join(parent, "evidence");
  try {
    assert.equal(existsSync(out), false);
    await bootstrapSmokeEvidence({ SMOKE_EVIDENCE_OUT: out, GITHUB_SHA: sha });
    assert.equal(existsSync(out), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("writeSmokePhaseFailure writes summary and console artifacts", async () => {
  const out = mkdtempSync(join(tmpdir(), "smoke-phase-"));
  try {
    await writeSmokePhaseFailure(
      { SMOKE_EVIDENCE_OUT: out },
      "hurl",
      new Error("pages check failed"),
    );
    const summary = JSON.parse(readFileSync(join(out, "failure-summary.json")));
    assert.equal(summary.phase, "hurl");
    assert.equal(summary.error, "pages check failed");
    assert.equal(existsSync(join(out, "failure-console.json")), true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
