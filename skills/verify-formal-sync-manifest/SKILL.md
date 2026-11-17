---
name: verify-formal-sync-manifest
description: "Check manifest merge does not resurrect trashed items as updates. Use when changing planManifestMerge or store sync import."
---

# Verify sync manifest merge

Trashed vault items (`deletedAt` set) are excluded from the merge map; a manifest entry at the same path re-adds rather than patching in place.

Replay: `packages/app-core/src/lib/vault/store-sync-formal.replay.test.ts`.

Model: `spec/formal-verification/sync-manifest/ManifestMerge.tla` (`NoReviveTombstone` on the tombstone path).