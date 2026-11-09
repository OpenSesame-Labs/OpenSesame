# ADR 0220 — The product repository tracks no AI-harness dotfiles or dot folders

- **Status:** Accepted
- **Date:** 2026-11-09
- **Builds on:** [ADR 0130](0130-operator-controlled-capability-composition.md)
  (capabilities are operator-composed, not baked into the product)
- **Amends:** the earlier "product adapters stay tracked" arrangement in
  [agent setup](../contributing/agent-setup.md), where hooks, rules and MCP
  definitions for each harness were committed beside the product.

## Context

The repository carried harness-owned configuration for several tools at the
top level: `.agents/`, `.claude/`, `.codex/`, `.cursor/`, `.grok/`,
`.githooks-grok/`, `.impeccable/` (root and nested), `.stitch/` and
`.mcp.json`. That mixed one operator's tooling choices (hooks, rules, MCP
servers, a Cursor Cloud image, a workflow runner) into the product's source,
inflated its footprint, and made every harness change a product change.

## Decision

1. **No AI-harness dotfile or dot folder is tracked.** They live in the
   OpenSesame Labs dotfiles repo and are applied per user.
2. **They are gitignored outright**, with no whitelist, so that anything a
   harness or skills installer writes into a working tree can never be staged.
3. **First-party skill source stays in `skills/`**, and `skills/profiles.json`
   remains the catalogue. The `.agents/skills/` discovery aliases are optional
   local output: `sync-agent-skills.mjs --check` validates any that exist but
   no longer requires them.
4. **Tests that pinned harness-owned files moved with them.** Tests of
   product scripts (`install-dependencies.sh`, the devcontainer, image-base
   pinning, scheduled audits) stay.

## Consequences

- A fresh clone has no Claude, Codex, Cursor or Grok behavior until the
  dotfiles are applied. This is intended.
- The `SessionStart` bootstrap gate (explicit `OPENSESAME_AGENT_BOOTSTRAP=1`
  and refusal when production-shaped credentials are present) is a property
  of the harness hook and now belongs to the dotfiles repo. The product's own
  `scripts/dev/install-dependencies.sh` remains and is still tested.
- The Cursor Cloud agent environment is no longer defined here.
- Scripts under `scripts/dev` and `scripts/audit` that drive Grok, Kimi and
  deepsec remain in this repository and are not covered by this decision.
  `.deepsec/` is a scanner workspace, not harness configuration, and stays.
