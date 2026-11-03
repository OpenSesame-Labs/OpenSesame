# Identity API image

`ghcr.io/opensesame-labs/control-plane` runs the Identity API
(`@opensesame/control-plane`) as uid `10001` on port `8788`.

```bash
docker build -f ops/containers/control-plane/Dockerfile -t control-plane:local .
```

The image sets `OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0`,
`OPENSESAME_CONTROL_PLANE_PORT=8788`, and `OPENSESAME_ALLOW_NONLOCAL=1`.
A non-loopback bind is production exposure, so the process refuses to boot
until the operator sets:

| Variable | Notes |
|---|---|
| `OPENSESAME_ENV` | `production` |
| `OPENSESAME_CLAIM_PEPPER` | At least 32 characters |
| `OPENSESAME_OPERATOR_TOKEN` | Host API device-approve proxy |
| `DATABASE_URL` | Durable Identity store |
| `OPENSESAME_PUBLIC_URL` | HTTPS origin browsers use |
| `OPENSESAME_ISSUER` | HTTPS, usually the same origin |

Liveness is `GET /v1/health/live`. The image does not embed a pepper, a
token, or a database URL. `tsx` stays in the image because the server
starts from TypeScript sources.

CI publishes `linux/amd64`. Add `linux/arm64` with `docker buildx build
--platform linux/amd64,linux/arm64` when a multi-arch builder is available.
The workspace install under emulation is slow; prefer a native arm64 runner.
