---
name: verify-formal-release-promotion
description: "Check promotion authorizes the qualified candidate without rewriting version or digest. Use when changing candidate publish or promotion.json."
---

# Verify release promotion

`validatePromotion` requires the promoted envelope to match the published candidate id, source sha, run ids, and payload digest.

Replay: `scripts/release/lib/candidate-published-formal.replay.test.mjs`.

Model: `spec/formal-verification/release-promotion/ReleasePromotion.tla` (`NoPromotionRewrite`).

**Property:** A published promotion envelope must name the same candidate id, source sha, run ids, and payload digest as the qualified candidate.

**Harm:** Accepting a mismatched promotion would ship the wrong artifact digest under a trusted release id.

**Scratch-break:** `node scripts/formal-scratch-break-four.mjs` (section `release-promotion`). Log: `/opt/cursor/artifacts/formal-scratch-breaks/release-promotion.log` — baseline pass, scratch fail, revert pass.