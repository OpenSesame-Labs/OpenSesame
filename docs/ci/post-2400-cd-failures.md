# Post–#2400 main CD failures (2026-11-02)

**Current status:** npm publication is disabled until an immutable npm candidate and candidate-bound promotion are implemented. The shared publishing action refuses to publish; the CD workflows run local package proofs and do not read `NPM_TOKEN`. The incident details and publisher rows below describe the historical configuration, not instructions to re-enable it. Preserve environment protections. See [publishing](../operators/publishing.md) for the prerequisites to restore publication.

Two CD runs failed on `main` at commit `532023689a8e4e6bc6d3d90e3607fc1f5efdeee7` after #2400. A later Production dist-tag move failed on run [41449588648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41449588648). After #2403 landed, Preview npm publish failed with `ENEEDAUTH` on runs [41507534648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41507534648) (CD PWA) and [41507534446](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41507534446) (CD npm CLI). #2413 stamped the Pages release. #2414 recorded this RCA, added a live promotion-gate proof, published Production as `0.0.0-next.N` under a distinct semver, and bound Preview npm publish to environment Preview for `NPM_TOKEN`. Production then failed `ENEEDAUTH` when that publish used an empty `npm-token` (OIDC only). Pinned npm attempts OIDC even with a token and can fall back to that token.

## Preview npm ENEEDAUTH — runs [41507534648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41507534648) and [41507534446](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41507534446)

| | |
| --- | --- |
| Symptom | Job **Preview npm publish** failed with `npm error code ENEEDAUTH` / `Access token expired or revoked` while staging and Pages deploy succeeded. |
| Root cause | **`NPM_TOKEN` lives on the GitHub environment Preview**, not as a repository secret. Preview publish jobs omitted `environment: Preview`, so `secrets.NPM_TOKEN` was empty and npm fell through to unauthenticated publish. |
| Historical change | The Preview publish jobs selected `environment: Preview` and supplied its `NPM_TOKEN` to `publish-npm-package`. Those jobs now run local proofs and cannot publish. |

## CD PWA — run [41485623019](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41485623019)

| | |
| --- | --- |
| Symptom | Job **Production verify and publish** failed: `Release probe HTTP 404` after eight “Release not visible yet” waits (5s apart). |
| Probe | `{page_url}release.json?release=<40-char-sha>` (this run: `https://opensesame-labs.github.io/OpenSesame/`). |
| Root cause | **`main` did not stamp `release.json` into `apps/pages/dist` before `upload-pages-artifact`.** The Pages deploy succeeded. The live site had no release marker, so the probe stayed 404. Retries cannot fix a missing file. |
| Fix | #2413 already stamps. `cd-pwa.yml` job **Build Pages and stage npm** runs `node scripts/release/pages-release.mjs stamp apps/pages/dist "$GITHUB_SHA"` **before** `upload-pages-artifact`. `npm-cd-workflows.test.mjs` asserts that stamp step. The verify budget in `pages-release.mjs` (8×5s) stays. |

## CD npm CLI — run [41485623157](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41485623157)

| | |
| --- | --- |
| Symptom | Job **Production npm publish** failed with a **Production environment rejection**. The job log blob is no longer available (GitHub 404). Earlier jobs **Stage CLI release** and **Preview approval** succeeded. |
| What `main` did | The Production job selected `environment: Production`. Protection rules still rejected that deployment. Preview on that workflow shape did not publish `@opensesame-labs/cli@alpha` (the preceding job was **Preview approval**). |
| Historical change | The prior setup removed required reviewers. Do not remove or weaken protections for a future publisher; independently configure and verify its release boundary. |

## Production dist-tag — run [41449588648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41449588648)

| | |
| --- | --- |
| Symptom | Job **Production npm dist-tag** on commit `bbee747376fe57ef4c873d80d2615087a3a03808` failed `E401` on `PUT https://registry.npmjs.org/-/package/@opensesame-labs%2fcli/dist-tags/next`. npm also warned that tokens which bypass 2FA are restricted. |
| Root cause | `npm dist-tag add … next` used `NODE_AUTH_TOKEN` from `NPM_TOKEN`. A granular bypass-2FA token can `npm publish` and still be **unauthorized to change dist-tags**. |
| Historical change | The former Production job avoided `npm dist-tag add` by rewriting the staged version and publishing it as `next`, with OIDC and a token fallback. That rebuilt/re-versioned artifact was not part of a qualified npm candidate; npm publication is now disabled. |

## Historical npm authentication

| Phase | Auth |
| --- | --- |
| Preview publish (`0.0.0-alpha.N`, tag `alpha`) | **`environment: Preview`** secret **`NPM_TOKEN`** via `publish-npm-package` (`NODE_AUTH_TOKEN` + `.npmrc`); otherwise **OIDC** under the same environment (`id-token: write`, `--provenance`). |
| Production publish (`0.0.0-next.N`, tag `next`) | **`environment: Production`** secret **`NPM_TOKEN`** via `publish-npm-package` (`NODE_AUTH_TOKEN` + `.npmrc`) and `npm publish --tag next --provenance`. When `NPM_TOKEN` is empty, **OIDC** under the same environment. Production does not run `npm dist-tag add` and never publishes `latest`. |

The former trusted publisher rows targeted organization `OpenSesame-Labs`, repository `OpenSesame`, and the Preview or Production environment. A machine-readable record is in `github-setup-spec.json` → `npm_trusted_publishing.publishers`; future promotion must establish and verify its own protected publisher controls.

| Package | Workflow filename | Environment |
| --- | --- | --- |
| `@opensesame-labs/cli` | `cd-npm-cli.yml` | `Preview` |
| `@opensesame-labs/cli` | `cd-npm-cli.yml` | `Production` |
| `@opensesame-labs/web-pwa` | `cd-pwa.yml` | `Preview` |
| `@opensesame-labs/web-pwa` | `cd-pwa.yml` | `Production` |

The current npm package proof jobs do not have publishing OIDC permission. The separate GitHub Pages deploy retains its required Pages OIDC permission.

## Live promotion gate proof

**CD promotion gates proof** simulates a blocked path on pull requests. It does not run the real CD workflows.

To exercise the smoke gate on a real `main` run:

1. **workflow_dispatch** **CD PWA** or **CD npm CLI** on `main` with **`dry_run: false`** and **`proof_gate_fail: true`**.
2. The smoke step sets `CD_PROOF_GATE_FAIL=1` and throws `intentional promotion gate proof failure`.
3. The final job is skipped and **`promotion_failed`** posts the commit comment.

`proof_gate_fail` defaults to false and applies only to `workflow_dispatch`. Push-triggered runs do not set it. npm is never published. The Pages workflow deploys the live Pages artifact before its smoke gate, so a forced smoke failure does not block that deployment.
