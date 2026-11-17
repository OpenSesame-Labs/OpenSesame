---
name: verify-formal-pwa-shell
description: "Check that the PWA shell does not mount consent routes until the vault plan has activated, while still allowing timeout and later-generation fallbacks. Use when changing useShellReady or vault composition activation gating."
---

# Verify PWA shell ready gate

`useShellReady` must not treat a stale `opened` latch from the no-plan window as permission to mount after the vault plan resolves and modules are still activating.

## Rerun

```bash
OUT="$(mktemp -d)" && statechart spec/formal-verification/pwa-shell-ready/PwaShellReady.tla --view spec/formal-verification/pwa-shell-ready/PwaShellReady.view.mjs --config spec/formal-verification/pwa-shell-ready/PwaShellReady.cfg --out "$OUT/chart"
```

Replay tests: `apps/pages/src/bindings/shell-ready-formal.replay.test.ts` and `apps/pages/src/app-root.shell-ready.test.tsx`.

## Product finding

Stale `opened` after `snapshot.plan` resolves could mount the consent shell before activation (TLC: `NoShellBeforeActivationOrTimeout`). Fixed in `apps/pages/src/bindings/shell-ready.ts` via `awaitingPlanActivation`.