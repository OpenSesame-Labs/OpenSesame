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
`control-plane` installs production dependencies only, keyed on the npm
manifests alone, so a cold build pays for one `npm ci --omit=dev` and every
later run — including a feature-branch `workflow_dispatch` whose lockfile
matches main — reuses the warm dependency layers instead of rebuilding and
re-exporting them. Do not raise the timeout to get a cold build through.

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
the cap; a manual proof retry can reuse the cache. The `control-plane` layers
that carry `node_modules` are keyed on the npm manifests, so retries and
feature-branch dispatches skip its dependency install when the lockfile is
unchanged.

## Vulnerability scanning

The weekly security workflow
([`security.yml`](../../.github/workflows/security.yml), also runnable by hand)
scans container images with OSV-Scanner, layer by layer. This covers what the
lockfile scans cannot see: the base image's operating-system packages and
anything a build copies in. No image is ever run. There are two kinds of scan,
each in its own code-scanning categories.

| Category | What is scanned | What a finding means |
|---|---|---|
| `container-source-<image>-<platform>` | The image the current source builds, from each Dockerfile on the scanned commit | A finding to fix in the repository: a base image digest, a package, or what a build copies in |
| `container-image-<image>-<tag>-<platform>` | The historical `:next` and `:latest` registry tags, while they exist | A finding in an artifact people can still pull, which the repository cannot change |

Both cover each image and platform the proof workflow builds (`linux/amd64`
for all four images and `linux/arm64` for `cli` and `control-plane`), and a
test keeps both lists equal to the proof's.

- **Source images.** Each image is built exactly as
  [`cd-ghcr-publish.yml`](../../.github/workflows/cd-ghcr-publish.yml) builds
  it: the same checkout, Dockerfile, target, build-arg and runner, the same
  prepared inputs (the musl `opensesame` binary and the pinned Tailscale
  WASM distributions), with `push: false`. It reads the proof's layer and Rust
  caches and never writes them. The summary names the Dockerfile and commit.
- **Historical tags.** Each image is pulled by the digest of its own platform
  entry. Older version tags are not rescanned. When the registry reports that
  `:next` or `:latest` no longer exists (an unknown manifest), the row uploads
  an empty OSV-Scanner report to that tag's category and says so in the
  summary, so code scanning closes the deleted artifact's alerts as fixed. Any
  other registry error fails the row.
- The job summary counts findings per advisory.
- Findings do not turn a job red. A base image always carries some, and a
  permanently red job is one nobody reads. A job fails when an image cannot be
  built or pulled, or when the scanner did not produce a complete report, so
  "did not run" never reads as "nothing found".

### Clearing the historical-tag alerts

Changes to a base image digest or dependency do not update the historical tags
while publication is disabled, so their alerts cannot be fixed from the source.
Fix what the `container-source-*` categories report. Then remove the stale
artifacts, by one of:

1. Delete the `next` and `latest` package versions of each image in GHCR
   (the organization's **Packages** page, then the package's versions).
   A version carries all of its tags, so deleting it removes each of them.
   Delete the tagged versions, not the whole package: a package that no longer
   exists is a registry error, which fails the row instead of closing it.
2. Ship qualified OCI promotion ([restoring qualified
   publication](#restoring-qualified-publication)), which republishes those
   tags from a qualified candidate.

The next scheduled or hand-started run of the security workflow then closes
the deleted tags' categories, or rescans the republished images.

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
sources. The build stays inside the ten-minute proof cap on cold and warm
cache by shape, not by timeout: it installs production dependencies only (no
dev toolchain stage), and the `manifests` stage prunes the context to what
`npm ci` reads — root manifests, `patches`, and every workspace
`package.json` — before `npm ci --omit=dev` runs. Sources are copied after
that install, so the dependency layers are keyed on the manifests and a
branch whose lockfile matches main reuses main's warm layers instead of
rebuilding and re-exporting `node_modules`.

A networked bind (`OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0` and
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
That binary is `x86_64-unknown-linux-musl`. The Alpine runtime does not
install a glibc compatibility layer.

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
