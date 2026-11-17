import { envelope } from "./candidate-model.mjs";
import { demand, hash } from "./candidate-policy.mjs";

/** Same invariants as validatePromotion in candidate-published.mjs (formal replay). */
export function validatePromotionForFormal(
  promotion,
  published,
  publishedBytes,
  repository,
) {
  demand(
    promotion.format === "opensesame-promotion" &&
      promotion.schema_version === 1 &&
      promotion.repository === repository,
    "Unknown published promotion schema",
  );
  const promoted = envelope(promotion.candidate);
  demand(
    promoted.candidate_id === published.candidate_id &&
      promoted.source_sha === published.source_sha &&
      promoted.run_id === String(published.producer.run_id) &&
      promoted.run_attempt === String(published.producer.run_attempt) &&
      promoted.payload_digest === hash(publishedBytes),
    "Published promotion does not authorize this candidate",
  );
}
