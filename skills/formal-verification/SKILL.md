---
name: formal-verification
description: "Shared formal-verification helpers for OpenSesame: statechart Pele theme, chart render, and conventions for verify-formal-* skills. Use when rendering TLC charts or documenting how subsystem verify skills theme PNG/SVG output."
---

# Formal verification (shared)

Subsystem checks live in `skills/verify-formal-<area>/SKILL.md` (one per area). This skill holds **one** reusable chart theme and render entrypoint so those skills do not duplicate Pele CSS or statechart install paths.

## Design tokens (source of truth)

Pull colors, typography, and radii from:

- **`apps/pages/src/styles.css`** — runtime CSS variables (`:root` light, `@media (prefers-color-scheme: dark)`, `:root[data-theme="dark"]`).
- **`DESIGN.md`** — product contract (greyscale ink-on-paper; `rounded.md` / `rounded.lg` are `0`).

The themed Pele overlay is **`skills/formal-verification/statechart-pele-theme.css`**. When `styles.css` or `DESIGN.md` changes a token this file mirrors, update the CSS here in the same change (or in the verify skill PR that depends on it).

### Group / phase mapping (statechart → OpenSesame)

| statechart class | Light fill (token) | Dark fill (token) |
|------------------|-------------------|-------------------|
| `blue` | `#f0f0f0` (`--surface-2`) | `#1d1d1d` (`--surface-2`) |
| `orange` | `#e6e6e6` (`--warn-wash`) | `#2b2b2b` (`--warn-wash`) |
| `purple` | `#e2e2e2` (`--surface-3`) | `#2a2a2a` (`--surface-3`) |
| `yellow` | `#efefef` (`--ok-wash`) | `#222222` (`--ok-wash`) |
| `teal` | `#efefef` (`--accent-wash`) | `#242424` (`--accent-wash`) |
| `tan` | `#e2e2e2` (`--surface-3`) | `#1d1d1d` (`--surface-2`) |
| `pink` | `#d9d9d9` (`--err-wash`) | `#3a3a3a` (`--err-wash`) |

| Mark class | Role | Light | Dark |
|------------|------|-------|------|
| `breaks` | invariant violation | fill `--err-wash`, stroke `--err` / ink | fill `--err-wash`, stroke `--err` |
| `mayBreak` | partial violation | fill `--warn-wash`, stroke `--warn` | same tokens (dark block) |
| `bugPath` | shortest path | stroke `--ink` / accent | stroke `--accent` |
| `repeats` | looping PROPERTY | dashed `--mark-slit` | dashed `--mark-slit` (dark) |

## TLC charts: `/statechart` then render

1. Run the pstack **`/statechart`** skill to produce `chart.mmd` (scratch folder outside the repo is fine).
2. Render with this repo script (Pele **1.9.0** pinned). Charts must use a **`--view`** module from `/statechart` so state labels are in the reader's words, not raw TLA+ variable dumps.

```bash
npm install pele@1.9.0 --prefix "$HOME/pele-render"   # once per machine, outside repo
NODE_PATH="$HOME/pele-render/node_modules" node skills/formal-verification/scripts/render-pele-chart.mjs \
  --mmd /path/to/chart.mmd --out /path/to/out --mode both --png --pixel-diff
```

- **`pele-theme-tokens.mjs`** bakes literal hex from `apps/pages/src/styles.css` into each SVG so **resvg** PNGs show ink-on-paper contrast (CSS variables alone are not enough for rasterizers).
- **`--strip-legend`** (default): removes the statechart **Legend** subgraph and its `class lgN` lines so charts have **no explainer text**. Themed renders also drop every `classDef` line so statechart's default mark colors are not painted.
- **`--mode both`**: writes `*.light.png` / `*.dark.png` plus `*.default.png` for before/after proof; `--pixel-diff` writes `pixel-diff.json`.

Do **not** copy `/statechart` script paths into verify skills; refer to **`/statechart`** and **`formal-verification`** (this skill) by name only.

## Verify-formal-* skills

Each `skills/verify-formal-<subsystem>/SKILL.md` must:

- Point to `/statechart` for TLC and counterexample narration.
- Point to **`formal-verification`** (this skill) for themed Pele render and `statechart-pele-theme.css`.
- Record coverage files/functions and sync commit; rerun one pinned command that includes the render step when charts are part of the deliverable.