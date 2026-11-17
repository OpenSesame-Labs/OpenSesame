---
name: verify-formal-release-promotion
description: "Check promotion authorizes the qualified candidate without rewriting version or digest. Use when changing candidate publish or promotion.json."
---

# Verify release promotion

`validatePromotion` requires the promoted envelope to match the published candidate id, source sha, run ids, and payload digest.

Replay: `scripts/release/lib/candidate-published-formal.replay.test.mjs`.

Model: `spec/formal-verification/release-promotion/ReleasePromotion.tla` (`NoPromotionRewrite`).