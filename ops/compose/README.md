# Compose runtime image

This directory holds the **native CLI runtime** container (`opensesame`), not the
Pages PWA. GitHub Pages and static vault landing content stay file-based; only
deployable server/workload surfaces use this image.

Build:

```bash
docker build -f ops/compose/Dockerfile -t opensesame:local .
```

The default entrypoint is the `opensesame` binary. Host API, daemon, and worker
roles are subcommands (`host run`, `daemon run`, `worker run`). The image runs
as uid `10001`, listens on `0.0.0.0:8787` (`OPENSESAME_ALLOW_NONLOCAL=1`,
because a published container port is not loopback), and stores daemon state
in the `/var/lib/opensesame` volume (`OPENSESAME_STATE_DIR`). A health check
requests `GET /health/live` and applies to `host run`; override it for
`worker run` and `daemon run`.

OCI labels record the source repository, `VERSION` build-arg (default
`0.0.0-local`), the MIT license, the title `opensesame`, and
`dev.opensesame.env.documentation` (the [GHCR image catalogue](../../docs/operators/ghcr-images.md)).
`scripts/ci/oci-image-config.mjs` prints the inspect fields tests expect.

Optional bridge features are compile-time only:

```bash
docker build -f ops/compose/Dockerfile --build-arg OPENSESAME_FEATURES=bitwarden-compat -t opensesame:bitwarden .
```

CI validates this Dockerfile through `.github/workflows/container-build-pr.yml`
during release promotion.
