# Post–#2400 main CD failures (2026-11-02)

Two CD runs failed on `main` at commit `532023689a8e4e6bc6d3d90e3607fc1f5efdeee7` after #2400. A later Production dist-tag move failed on run [41449588648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41449588648). #2413 stamps the Pages release. #2414 records this RCA, adds a live promotion-gate proof, and publishes Production with OIDC under a distinct semver.

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
| Fix | Remove required reviewers on Production and Preview per `github-setup-spec.json`. The Production job still selects `environment: Production` so an npm trusted publisher can bind to it. Do not add required reviewers back. |

## Production dist-tag — run [41449588648](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41449588648)

| | |
| --- | --- |
| Symptom | Job **Production npm dist-tag** on commit `bbee747376fe57ef4c873d80d2615087a3a03808` failed `E401` on `PUT https://registry.npmjs.org/-/package/@opensesame-labs%2fcli/dist-tags/next`. npm also warned that tokens which bypass 2FA are restricted. |
| Root cause | `npm dist-tag add … next` used `NODE_AUTH_TOKEN` from `NPM_TOKEN`. A granular bypass-2FA token can `npm publish` and still be **unauthorized to change dist-tags**. |
| Fix | Production does **not** run `npm dist-tag add`. It rewrites the staged `package.json` from `0.0.0-alpha.N` to `0.0.0-next.N` (same numeric suffix) and runs `publish-npm-package` with `npm-dist-tag: next` and `npm-token: ""` (OIDC `npm publish --tag next --provenance` of those staged bytes). The job still uses `environment: Production`. Preview still publishes `0.0.0-alpha.N` on tag `alpha` with the repository `NPM_TOKEN` when set, otherwise OIDC with no environment. |

## npm authentication

| Phase | Auth |
| --- | --- |
| Preview publish (`0.0.0-alpha.N`, tag `alpha`) | Repository secret **`NPM_TOKEN`** if set; otherwise **OIDC** (`id-token: write`, `--provenance`). Preview jobs do not select a GitHub environment. |
| Production publish (`0.0.0-next.N`, tag `next`) | **OIDC only** under `environment: Production`. `npm-token` is empty. Production does not read `NPM_TOKEN`. |

Trusted publisher rows on npmjs.com → package → **Settings** → **Trusted Publisher** → **GitHub Actions**. Organization or user: `OpenSesame-Labs`. Repository: `OpenSesame`. Allow **npm publish**. Leave **environment** empty for Preview. Set it to `Production` for the Production row. Machine-readable copy: `github-setup-spec.json` → `npm_trusted_publishing.publishers`.

| Package | Workflow filename | Environment |
| --- | --- | --- |
| `@opensesame-labs/cli` | `cd-npm-cli.yml` | *(empty — Preview publish)* |
| `@opensesame-labs/cli` | `cd-npm-cli.yml` | `Production` |
| `@opensesame-labs/web-pwa` | `cd-pwa.yml` | *(empty — Preview publish)* |
| `@opensesame-labs/web-pwa` | `cd-pwa.yml` | `Production` |

Workflow permissions already include `id-token: write`.

## Live promotion gate proof

**CD promotion gates proof** simulates a blocked path on pull requests. It does not run the real CD workflows.

To block Production on a real `main` run:

1. Confirm Production and Preview have **no required reviewers**.
2. Configure repository **`NPM_TOKEN`** and/or the trusted publisher rows above.
3. **workflow_dispatch** **CD PWA** or **CD npm CLI** on `main` with **`dry_run: false`** and **`proof_gate_fail: true`**.
4. The preview smoke step sets `CD_PROOF_GATE_FAIL=1`. `cd-preview-smoke.mjs` throws `intentional promotion gate proof failure`.
5. **Production** is skipped. **`promotion_failed`** posts the commit comment.

`proof_gate_fail` defaults to false and applies only to `workflow_dispatch`. Push-triggered runs do not set it. Preview publish still runs before that smoke gate, so the proof publishes the alpha package and then blocks Production.
