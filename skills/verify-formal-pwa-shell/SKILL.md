---
name: verify-formal-pwa-shell
description: "Check that the PWA shell does not mount consent routes until the vault plan has activated, while still allowing timeout and later-generation fallbacks. Use when changing useShellReady or vault composition activation gating."
---

# Verify PWA shell ready gate

`useShellReady` must not treat a stale `opened` latch from the no-plan window as permission to mount after the vault plan resolves and modules are still activating. The gate is derived during that render, not only in the effect that follows it.

Requires `formal-verification` for the Pele render after `/statechart`.

## Rerun

From the repo root. TLC is the pstack `/statechart` skill. Nothing in this repo installs a `statechart` binary. Invoke `/statechart` the way `skills/formal-verification/SKILL.md` describes, then render with the `formal-verification` skill. The output directory must be new and sit outside the repo.

```bash
OUT="$(mktemp -d)"
```

Invoke `/statechart` with spec `spec/formal-verification/pwa-shell-ready/PwaShellReady.tla`, view `spec/formal-verification/pwa-shell-ready/PwaShellReady.view.mjs`, config `spec/formal-verification/pwa-shell-ready/PwaShellReady.cfg`, and `--out "$OUT/chart"`. Then:

```bash
npm install pele@1.9.0 --prefix "$HOME/pele-render" && NODE_PATH="$HOME/pele-render/node_modules" node skills/formal-verification/scripts/render-pele-chart.mjs --mmd "$OUT/chart/chart.mmd" --out "$OUT/rendered" --mode both --png
```

Replay tests: `apps/pages/src/bindings/shell-ready-formal.replay.test.ts` and `apps/pages/src/app-root.shell-ready.test.tsx`.

## Product finding

Stale `opened` after `snapshot.plan` resolves could mount the consent shell before activation (TLC: `NoShellBeforeActivationOrTimeout`). Fixed in `apps/pages/src/bindings/shell-ready.ts`: the null-to-plan render passes `awaitingPlanActivation` before the effect commits. The model's `fromNull` latch is coarser than that render-time flag; `shell-ready-formal.replay.test.ts` is the product oracle for the gap.