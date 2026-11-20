# User token fingerprint label (PR #2823)

Playwright evidence for `UserTokenPanel` token proof label: **before** shows `sha256:0123456789ab…` (pre-change), **after** shows `scrypt:0123456789ab…`.

Script: `apps/pages/scripts/capture-user-token-fingerprint-label.mjs` (four checklist profiles).

| Profile | Panel reachable? | Notes |
|---------|------------------|-------|
| `minimal-local` | No | Furthest state is connections landing **without** Import connectors; `UserTokenPanel` is not installable without `connectors.external`. |
| `default` | Yes | Default setup enables external connectors. |
| `custom` | Yes | Custom ceremony applies `connectors.external` via capabilities consent before Skip all. |
| `full` | Yes | Full fixture enables external connectors. |

Artifacts: `pages/web/{before,after}/<profile>/user-token-fingerprint-label.png` (plus checklist step PNGs in each folder).

Run:

```bash
cd apps/pages
node scripts/capture-user-token-fingerprint-label.mjs --phase before
node scripts/capture-user-token-fingerprint-label.mjs --phase after
```

Do not set `VERIFY_SKIP_BUILD=1`; each phase must rebuild dists so the bundled label matches the phase.