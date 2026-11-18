---
name: verify-formal-vault
description: "Check that the vault screen never says a second step is still waiting while the vault is open. Use when changing vault lock, unlock, the parked second step, or buildVaultState."
---

# Verify the vault unlock screen

The vault screen never says a second step is still waiting while the vault is open.

If it did, every surface that treats `awaitingSecondStep` as "the key is parked and the vault is not open" would treat an open vault as unfinished. Cancelling that challenge locks the session. A person who had already opened the vault would be locked out by a second step the screen should have dropped.

The check is a TLA+ model of the snapshot `buildVaultState` publishes, read with `/statechart`. Charts are drawn with `formal-verification` (Pele 1.9.0, outside the repo). A pass covers this finite model, not the cryptography and not every vault feature.

## Rerun

From the repo root. TLC is the pstack `/statechart` skill. Nothing in this repo, `package.json`, or `mise.toml` installs a `statechart` binary, so a shell named `statechart` stops at `command not found`. Invoke `/statechart` the way `skills/formal-verification/SKILL.md` describes, then render with the `formal-verification` skill. Do not replace either skill with a copied script path. The output directory must be new, and it must sit outside the repo.

```bash
OUT="$(mktemp -d)"
```

Invoke `/statechart` with the spec `spec/formal-verification/vault-presentation/VaultPresentation.tla`, `--view spec/formal-verification/vault-presentation/VaultPresentation.view.mjs`, and `--out "$OUT/chart"`. That skill writes `chart.mmd`. Then render it:

```bash
npm install pele@1.9.0 --prefix "$HOME/pele-render" && NODE_PATH="$HOME/pele-render/node_modules" node skills/formal-verification/scripts/render-pele-chart.mjs --mmd "$OUT/chart/chart.mmd" --out "$OUT/rendered" --mode both --png
```

`/statechart` exits 0 when every rule holds. The model has 14 distinct states. The chart labels come from `VaultPresentation.view.mjs` (`state()` and `step()`). No step is hidden.

## Coverage

| File | What the model follows |
| --- | --- |
| `packages/app-core/src/lib/vault/store-presentation.ts` | `buildVaultState`: `status` is `unlocked` when open, `locked` when a header exists and the session is not open, `empty` otherwise; `awaitingSecondStep = pending && !open` |
| `packages/app-core/src/lib/vault/store-unlock-session.ts` | `StoreUnlockSession.activate` (set the key, then clear the parked key, then publish), `requireTrusted` (clear the parked key, then open or publish the circle), `confirmTrusted`, `reset`, `cancel`, and `arm` (expiry calls `cancel`, which calls `lock`) |
| `packages/app-core/src/lib/vault/store.ts` | `lock` and `#clearLockedSessionState`; `#afterPrimaryUnwrap`; `unlock`, `unlockWithPin`, and `#openWithRaw`; `confirmTotp` (through `finishSecondStepUnlock`); `createGuest` on an empty device; `#persistNewVault` |

Sync commit: `ed4a8e61af81e227417b334a72329d49731feeca`

That commit is the product code this model was checked against. The files above match it. Move the sync commit forward only after you have confirmed the model still describes those files. A later commit that does not touch them does not need a new sync. Use `/maintain-formal-verification-skill` when the code moves and this check was not rerun.

Do not weaken `PresentationMatchesStore`, `NoStalePendingWhileOpen`, or `OpenSessionHasNoParkedKey`. If a run fails on the committed config (`BuggyUnlock = FALSE`), the failure is a finding about the code or a model that no longer matches it. Fix the model only when the code's published snapshot really changed. Do not change product behavior to make the check pass unless someone asked for that fix.

## Tell a real bug from a modeling error

Replay the failing path one published snapshot at a time. The replay test is `packages/app-core/src/lib/vault/vault-presentation-formal.replay.test.ts`. It drives the real `StoreUnlockSession` through `begin()`, a modeled primary-unwrap snapshot (`pending` while not open, matching `#afterPrimaryUnwrap` when a second step is enrolled), and `activate`. It does not run the full `VaultStore` create, enroll, lock, or primary-unlock pipeline. It asserts each `buildVaultState` view and that the parked key is clear once the session is open.

If that test fails, the screen formula or the unlock session has drifted and the model is reporting a product bug. If the test passes and TLC fails, the model and the code have diverged; read the diff of the covered files since the sync commit before changing a rule.

## Scratch break (BuggyUnlock)

The committed config sets `BuggyUnlock = FALSE`. That is the code: `activate` clears the parked key before publish, and `buildVaultState` uses `pending && !open`.

Prove the rules can fail. Copy `spec/formal-verification/vault-presentation/` to a scratch directory outside the repo. In the scratch config only, set `BuggyUnlock = TRUE`. Invoke `/statechart` on that copy with a new `--out` directory. Do not chain the render on a successful exit; this run must not succeed.

`/statechart` must report that the rules break. The shortest path is:

1. Nothing stored.
2. You create a vault.
3. You turn on a second step.
4. The vault locks.
5. You unlock and the vault asks for the second step (`awaitingSecondStep` is true, the vault is locked).
6. The vault opens while the second step still shows. TLC's state has the vault open, the parked key still set, and `awaitingSecondStep` true.

That state breaks `PresentationMatchesStore` (`awaitingSecondStep` is not `pending && !open`), `NoStalePendingWhileOpen`, and `OpenSessionHasNoParkedKey`. The action is `BuggyUnlockOpen`: it leaves `pending` true and sets `awaitingSecondStep` from `pending` alone.

Delete the scratch copy. Do not commit `BuggyUnlock = TRUE`.

## Left out

Wrong passwords, lockout counters, and which primary method was used. They meet at `#afterPrimaryUnwrap`. The idle timer calls the same `lock`. A guest beside an existing vault, decoy and honey sessions, the open-lease Web Lock, and the body contents are outside the model. The pass is this finite session, not the whole vault.
