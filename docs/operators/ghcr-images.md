# GHCR images

Hostable OpenSesame images. The registry is `ghcr.io/opensesame-labs`. Builds
use the repository root as the Docker context. Each publish job builds one
image and one platform, in parallel, with a 10 minute cap. `cli` and
`control-plane` build `linux/amd64` on `ubuntu-latest` and `linux/arm64` on
`ubuntu-24.04-arm` (no QEMU). `opensesame` and `web-pwa` are `linux/amd64`
only, so a cold build stays under the cap. A manifest
job publishes the shared tag from those platform images. Layer cache is GitHub Actions
(`type=gha`, `mode=max`), scoped by matrix id so rows do not clobber each
other. A cold cache on the first publish can still miss the 10 minute cap.
Retry with `workflow_dispatch` after that attempt has filled the cache. Do
not raise the timeout to get a cold build through.

Every image runs as uid `10001`, carries the same OCI labels (`source`,
`version` from the `VERSION` build-arg, `licenses=MIT`, `title`, and
`dev.opensesame.env.documentation` pointing here), and is described for tests
by `node scripts/ci/oci-image-config.mjs` (no Docker required).

| Image | `ghcr.io/opensesame-labs/…` | Build context | Role | Ports | Notes |
|---|---|---|---|---|---|
| `opensesame` | `opensesame` | `ops/compose/Dockerfile` | Native host: `host run`, `worker run`, `daemon run` | 8787 | Existing image. `VOLUME /var/lib/opensesame`. Health check is `GET /health/live` for `host run`. |
| `cli` | `cli` | `ops/containers/cli/Dockerfile` | Client CLI (`@opensesame/cli` release bundle). Binary name inside the image is `opensesame` from the npm layout. | none | Node 24. Not the native host binary. |
| `web-pwa` | `web-pwa` | `ops/containers/web-pwa/Dockerfile` | Static Pages dist plus `pages-pwa-serve` | 5180 | `HOST=0.0.0.0`. `GET /` is the PWA shell. |
| `control-plane` | `control-plane` | `ops/containers/control-plane/Dockerfile` | Identity API | 8788 | `GET /v1/health/live` after the operator env below is set. |
| `mock-upstream-idp` | — | `tools/mock-upstream-idp` | Mock upstream IdP | 9090 | Phase 2. The package is a workspace service with SAML and OAuth fixtures, not a small standalone image. |
| MCP client | — | `packages/mcp-client` | Agent-facing MCP server (stdio) | none | Phase 2. The bin is TypeScript source (`tsx`), not a release bundle. |
| MCP host | — | `packages/mcp-host` | Host-facing MCP server (stdio or loopback HTTP) | none | Phase 2. Same reason as the MCP client. |

Hermetic pull-request validation of the native Dockerfile stays in
[`.github/workflows/container-build-pr.yml`](../../.github/workflows/container-build-pr.yml):
`workflow_call` only, `push: false`, context `.`, file `ops/compose/Dockerfile`.
That workflow does not publish.

The headless browser benchmark on main is `workflow_dispatch` only, so the
automatic workflow inventory omits it.

## Publication status and proof builds

GHCR publication is disabled. The existing qualified candidate inventory contains
Pages and native kits but no OCI image artifacts. Rebuilding from `main` or a
release tag and pushing directly would bypass candidate qualification. Existing
registry tags, including `next`, version tags and `latest`, are historical and
will not be updated by the repository until qualified OCI promotion is added.

[`.github/workflows/cd-ghcr-publish.yml`](../../.github/workflows/cd-ghcr-publish.yml)
now runs image proof builds on relevant `main` pushes or manual dispatch. Every
ref uses `push: false`, loads the image locally, and runs the image smoke test.
It has no registry login, package write permission, publish credential or
manifest-push job. A release-tag push does not trigger the proof workflow.

A matrix row whose Dockerfile is absent on that revision is skipped. Builds and
proof jobs have a ten-minute cap. The `cli` and `control-plane` matrix covers
amd64 and arm64 on native runners; `opensesame` and `web-pwa` are amd64 only.
Each build retains its per-image GitHub Actions layer cache. A cold run may miss
the cap; a manual proof retry can reuse the cache.

## Vulnerability scanning

The weekly security workflow
([`security.yml`](../../.github/workflows/security.yml), also runnable by hand)
pulls each published image, saves it, and scans every layer with
OSV-Scanner. This covers what the lockfile scans cannot see: the base image's
operating-system packages and anything a build copies in. The image is never
run.

- Findings go to the code-scanning dashboard under the category
  `container-image-<image>-<tag>-<platform>`, one category per scanned image,
  so an advisory that is fixed disappears from that image's list.
- The job summary names the exact digest that was scanned and counts findings
  per advisory.
- Findings do not turn the job red. A base image always carries some, and a
  permanently red job is one nobody reads. The job fails when an image cannot
  be pulled or when the scanner did not produce a complete report, so "did not
  run" never reads as "nothing found".

It scans every platform each image publishes (`linux/amd64` for all four,
`linux/arm64` for `cli` and `control-plane`; a test keeps this list equal to
the publish workflow's) under both moving tags: `:next`, which every push to
`main` replaces, and `:latest`, which every release tag replaces. Each image is
pulled by the digest of its own platform entry. A release's `:<semver>` tag names the same image
`:latest` named when it was published, so the newest release is always
covered; an older release is not rescanned once a newer one replaces
`:latest`. Until the first release publishes `:latest`, its rows say so in the
summary and pass. A missing `:next` fails its row.

Fix a finding by moving the base image digest in the Dockerfile or the
dependency in the lockfile, then let the next publish replace the tag.

The dev container image is not published, so the same workflow builds it from
`.devcontainer/` and scans it the same way, under the category
`container-image-devcontainer`.

## `opensesame` environment

| Variable | Image default | Role |
|---|---|---|
| `OPENSESAME_LISTEN` | `0.0.0.0:8787` | Host API bind. Compose sets the same value. |
| `OPENSESAME_ALLOW_NONLOCAL` | `1` | Required for a non-loopback bind. |
| `OPENSESAME_STATE_DIR` | `/var/lib/opensesame` | Daemon and vault state volume. |
| `OPENSESAME_ISSUER` | unset | Upstream issuer URL. Compose points this at Keycloak. |
| `OPENSESAME_RESOURCE` | unset | Resource indicator for the Host API. |
| `OPENSESAME_DB` | unset | Postgres URL for the Host. |
| `OPENSESAME_TASKBUS` | unset | `nats` when the task bus is NATS. |
| `NATS_URL` | unset | NATS server URL. |
| `OPENSESAME_WORKER_PROVIDERS` | unset | Required on `worker run`: comma-separated provider ids. |
| `OPENSESAME_FEATURES` | empty build-arg | Compile-time bridges, for example `bitwarden-compat`. |

`GET /health/live` answers `ok`. Readiness is `GET /health/ready`. See
[Health and operations](health-and-operations.md).

## `cli`

The image builds `@opensesame/cli` with `CLI_RELEASE_PACK=1`, then
`scripts/release/prepare-cli-release.mjs`. The entrypoint is
`node dist/bin.js`, so `docker run … cli --version` prints the package
version. `npm install --omit=dev --ignore-scripts` in the release directory
skips the `agent-browser` browser download. Commands that need that browser
belong in a derived image.

## `web-pwa`

`npm run build -w @opensesame/pages`, then `prepare-pages-release.mjs`. The
server is `scripts/release/pages-pwa-serve.mjs` copied to `bin/serve.mjs`.
`PORT` defaults to `5180`. `HOST` defaults to `localhost` in the script so a
local `node` run stays on loopback; the image sets `HOST=0.0.0.0`. The image
is `linux/amd64` only.

## `control-plane`

The Identity API is started with `node --import tsx` on the workspace
sources. A networked bind (`OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0` and
`OPENSESAME_ALLOW_NONLOCAL=1` are set in the image) is production exposure.
The process refuses to boot until the operator sets:

| Variable | Notes |
|---|---|
| `OPENSESAME_ENV` | `production` (or `development` only for a loopback lab). |
| `OPENSESAME_CLAIM_PEPPER` | At least 32 characters. |
| `OPENSESAME_OPERATOR_TOKEN` | Host API device-approve proxy. |
| `DATABASE_URL` | Durable Identity store. |
| `OPENSESAME_PUBLIC_URL` | HTTPS issuer origin the browser uses. |
| `OPENSESAME_ISSUER` | HTTPS, usually the same origin. |
| `OPENSESAME_CONTROL_PLANE_PORT` | Default `8788`. |

`GET /v1/health/live` is the liveness check once that configuration is
present. The image does not embed a pepper, a token, or a database URL.

## Local build

`opensesame` compiles with `--target runtime`. The Dockerfile default is
`runtime-from-prebuilt`, which the proof workflow builds from
`ops/compose/prebuilt/opensesame` (mode 0755) and does not run cargo.

```bash
docker build -f ops/compose/Dockerfile --target runtime -t opensesame:local .
docker build -f ops/containers/cli/Dockerfile -t cli:local .
docker build -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
docker build -f ops/containers/control-plane/Dockerfile -t control-plane:local .
node scripts/ci/oci-image-smoke.mjs opensesame:local cli:local web-pwa:local
```

`oci-image-smoke.mjs` exits 0 with a skip line when `docker` is not on
`PATH` (cloud agents). With Docker, it runs `--version` for the host and
CLI images and expects HTTP 200 from the PWA. The Identity API curl runs
only when the container stays up; without the operator env it skips.

## Restoring qualified publication

The current weekly candidate inventory and promotion receipts do not include
OCI artifacts, so there is no qualified image digest for this workflow to push.
Adding a token or changing an environment setting alone must not re-enable the
old direct build-and-push path. The missing integration must:

1. Add the complete per-platform OCI artifacts and immutable manifest digests
   to the exact candidate inventory and bind them to the original build
   provenance and source revision.
2. Run the required smoke, security and other qualification gates against those
   exact image digests, and bind the results to the same candidate.
3. Promote those verified artifacts and manifests by digest in the weekly
   release flow without rebuilding or substituting source or platform images.
4. Require a dedicated `GHCR_PUBLISH_TOKEN` and `GHCR_PUBLISH_USER` only in a
   protected `container-release` environment limited to `main` and authorized
   release tags. Keep the credential out of repository and organization scope,
   and protect creation and movement of release tags.
5. Independently grant the dedicated publisher the needed access to the four
   official GHCR packages and remove the source repository's automatic Actions
   token write access, including inherited access. Protect the package names
   before allowing untrusted workflows to create packages in the namespace.

The environment rules, credential scope and GHCR package ACL are live GitHub
settings that this repository cannot configure or verify. They remain required
even after a future candidate-bound publisher is implemented. No such publisher
is enabled by the proof workflow.
