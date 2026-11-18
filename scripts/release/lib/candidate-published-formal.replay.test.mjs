import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { validatePromotionForFormal } from "./candidate-published-formal.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("release promotion formal replay", () => {
  it("rejects promotion when candidate_id does not match published bytes", () => {
    const bytes = Buffer.from("qualified-candidate-payload");
    const sourceSha = "a".repeat(40);
    const runId = "42";
    const runAttempt = "3";
    const digest = hash(bytes);
    const published = {
      candidate_id: `${sourceSha}-${runId}-${runAttempt}`,
      source_sha: sourceSha,
      producer: { run_id: Number(runId), run_attempt: Number(runAttempt) },
    };
    const promotion = {
      format: "opensesame-promotion",
      schema_version: 1,
      repository: "OpenSesame-Labs/OpenSesame",
      candidate: {
        source_sha: sourceSha,
        candidate_id: `${sourceSha}-${runId}-4`,
        run_id: runId,
        run_attempt: "4",
        artifact_id: "1",
        artifact_digest: digest,
        payload_digest: digest,
      },
    };
    assert.throws(
      () =>
        validatePromotionForFormal(
          promotion,
          published,
          bytes,
          promotion.repository,
        ),
      /does not authorize/,
    );
  });

  it("rejects promotion when only payload_digest mismatches published bytes", () => {
    const bytes = Buffer.from("qualified-candidate-payload");
    const sourceSha = "b".repeat(40);
    const runId = "99";
    const runAttempt = "1";
    const published = {
      candidate_id: `${sourceSha}-${runId}-${runAttempt}`,
      source_sha: sourceSha,
      producer: { run_id: Number(runId), run_attempt: Number(runAttempt) },
    };
    const promotion = {
      format: "opensesame-promotion",
      schema_version: 1,
      repository: "OpenSesame-Labs/OpenSesame",
      candidate: {
        source_sha: sourceSha,
        candidate_id: published.candidate_id,
        run_id: runId,
        run_attempt: runAttempt,
        artifact_id: "1",
        artifact_digest: hash(bytes),
        payload_digest: hash(Buffer.from("tampered-payload")),
      },
    };
    assert.throws(
      () =>
        validatePromotionForFormal(
          promotion,
          published,
          bytes,
          promotion.repository,
        ),
      /does not authorize/,
    );
  });
});
