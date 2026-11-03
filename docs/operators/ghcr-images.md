# GHCR images

Hostable OpenSesame images. The registry is `ghcr.io/opensesame-labs`. Builds
use the repository root as the Docker context. CI publishes `linux/amd64`.
Add `linux/arm64` with `docker buildx build --platform linux/amd64,linux/arm64`
when the CD runner has a native or QEMU builder; the Rust image stays amd64
until that builder exists, because a full Rust release under emulation does
not finish in a normal CD window.

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

## Tags

[`.github/workflows/cd-ghcr-publish.yml`](../../.github/workflows/cd-ghcr-publish.yml)
pushes on `main` and on `v*` tags. It is not a job in `ci.yml`.

| Git ref | Tags |
|---|---|
| `main` | `:next` and `:sha-<GITHUB_SHA>` |
| `v*` (for example `v1.2.3`) | `:<semver>` (`1.2.3`, the tag without `v`) and `:latest` |

A matrix row whose Dockerfile is not in that revision is skipped, so the
workflow can land before the Node Dockerfiles. Login uses `GITHUB_TOKEN`
against `ghcr.io`. `GHCR_PUBLISH_TOKEN` in the `container-release` environment
is an optional override and is not wired in. Do not dispatch the retired
[`.github/workflows/publish-containers.yml`](../../.github/workflows/publish-containers.yml).

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
local `node` run stays on loopback; the image sets `HOST=0.0.0.0`.

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

```bash
docker build -f ops/compose/Dockerfile -t opensesame:local .
docker build -f ops/containers/cli/Dockerfile -t cli:local .
docker build -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
docker build -f ops/containers/control-plane/Dockerfile -t control-plane:local .
node scripts/ci/oci-image-smoke.mjs opensesame:local cli:local web-pwa:local
```

`oci-image-smoke.mjs` exits 0 with a skip line when `docker` is not on
`PATH` (cloud agents). With Docker, it runs `--version` for the host and
CLI images and expects HTTP 200 from the PWA. The Identity API curl runs
only when the container stays up; without the operator env it skips.

## Tyler operator checklist

Do these by hand. The change that adds the workflow does not create a `v*`
tag, does not run `workflow_dispatch`, and does not open a GitHub release.

1. **Actions permission.** On the repository, Settings → Actions → General →
   Workflow permissions: allow GitHub Actions to create and approve pull
   requests is unchanged. Under the same page, grant workflows `Read and
   write` permissions, or set the `packages: write` permission this workflow
   already requests and confirm the organization allows it. The workflow
   token is `GITHUB_TOKEN`.
2. **Package visibility.** After the first publish, open each
   `ghcr.io/opensesame-labs/<name>` package (`opensesame`, `cli`, `web-pwa`,
   `control-plane`) and set visibility to **public** or **internal**. A new
   GHCR package is private until an owner changes it. Link each package to
   the OpenSesame repository so the Actions token can keep publishing.
3. **First manual run.** Actions → CD GHCR publish → Run workflow, on
   `main`. That is the first `workflow_dispatch`. Confirm the four matrix
   rows. A row whose Dockerfile is not on that commit is skipped. The run
   pushes `:next` and `:sha-<commit>`. It does not push `:latest`.
4. **Version tags.** Create and push `v*` yourself when a release should
   move `:latest`. The tag `v1.2.3` publishes `:1.2.3` and `:latest`. This
   document does not create that tag.
5. **Optional publish token.** To stop the default `GITHUB_TOKEN` from
   writing the official packages, create `GHCR_PUBLISH_TOKEN` in the
   `container-release` environment (limited to `main` and `v*` tags) and
   point the login step at it. The workflow comments name that override.
   Configuring the environment does not by itself publish.
6. **Remove the duplicate publisher path.** Do not run
   `.github/workflows/publish-containers.yml`. It stays a retired manual
   failure so qualification tests still reject an ungated publisher. Do not
   grant it `packages: write`, and delete any leftover GHCR package that an
   older publish path created under a different name once the four packages
   above are the ones you keep.
7. **Arm64.** The Node images request `linux/amd64,linux/arm64` on publish.
   The host image stays `linux/amd64` until a native arm64 builder exists.
   If the arm64 Node build is too slow under QEMU, narrow `platforms` for
   that row and record the digest from the amd64 run.

Image size is not in this commit. The first successful CD run records it in
the build log (`docker/build-push-action` output). Cloud agents without
Docker skip `scripts/ci/oci-image-smoke.mjs`.
