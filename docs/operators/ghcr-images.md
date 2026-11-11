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

## Tags

[`.github/workflows/cd-ghcr-publish.yml`](../../.github/workflows/cd-ghcr-publish.yml)
pushes on `main` and on `v*` tags. It is not a job in `ci.yml`. There is no
`pull_request` trigger and no `continue-on-error`.

| Git ref | Shared tags (manifest job) | Platform tags (one build job each) |
|---|---|---|
| `main` | `:next` and `:sha-<GITHUB_SHA>` | `:sha-<GITHUB_SHA>-amd64`, and `:sha-<GITHUB_SHA>-arm64` for `cli` and `control-plane` |
| `v*` (for example `v1.2.3`) | `:<semver>` (`1.2.3`, the tag without `v`) and `:latest` | `:<semver>-amd64`, and `:<semver>-arm64` for `cli` and `control-plane` |

Pull the shared tags. The platform tags exist so parallel jobs do not
overwrite each other before the manifest job runs. `opensesame` and
`web-pwa` publish the amd64 platform tag only.

Every matrix job, build and manifest, sets `timeout-minutes: 10`. Cache on
each build is `cache-from: type=gha` and `cache-to: type=gha,mode=max`, with
`scope` set to the row id (`opensesame-amd64`, `web-pwa-amd64`, `cli-amd64`,
`cli-arm64`, `control-plane-amd64` and `control-plane-arm64`).

A matrix row whose Dockerfile is not in that revision is skipped, so the
workflow can land before the Node Dockerfiles. The manifest job skips that
image too. Login uses `GITHUB_TOKEN` against `ghcr.io`. `GHCR_PUBLISH_TOKEN`
in the `container-release` environment is an optional override and is not
wired in. Do not dispatch the retired
[`.github/workflows/publish-containers.yml`](../../.github/workflows/publish-containers.yml).

The first publish on a cold GitHub Actions cache may fail the 10 minute
budget even though a warm cache fits. That failure is honest: the cap stays
10 minutes. Run the workflow again from Actions (`workflow_dispatch` on
`main`). The retry reuses the layer cache the first attempt wrote.

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
`runtime-from-prebuilt`, which GHCR publish builds from
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
   `main`. That is the first `workflow_dispatch`. Confirm one job per image
   and platform (`opensesame-amd64`, `web-pwa-amd64`, plus `cli` and
   `control-plane` each as amd64 and arm64) and a manifest job per image.
   A row whose Dockerfile is not on that commit is skipped. The run pushes
   `:next` and `:sha-<commit>`. It does not push `:latest`. A cold cache
   can fail the 10 minute cap; run the workflow again.
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
7. **Arm64.** `cli` and `control-plane` build `linux/arm64` on
   `ubuntu-24.04-arm` runners (native, no QEMU) with a separate GHA cache
   scope. `opensesame` and `web-pwa` publish `linux/amd64` only. The manifest
   job joins the platform tags into the shared tags. Do not fold amd64 and
   arm64 back into one build to save a job: that build does not fit the 10
   minute cap.

Image size is not in this commit. The first successful CD run records it in
the build log (`docker/build-push-action` output). Cloud agents without
Docker skip `scripts/ci/oci-image-smoke.mjs`.
