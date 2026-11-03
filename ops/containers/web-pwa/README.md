# Pages PWA image

`ghcr.io/opensesame-labs/web-pwa` serves the built static Pages app with
`scripts/release/pages-pwa-serve.mjs` (`bin/serve.mjs` in the npm release
layout, package `@opensesame-labs/web-pwa`).

```bash
docker build -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
docker run --rm -p 5180:5180 web-pwa:local
```

The server port is `PORT`, default `5180`. The script binds `HOST`, default
`localhost`, so a local `node` run stays on loopback. This image sets
`HOST=0.0.0.0` and exposes `5180`. It runs as uid `10001`.

CI publishes `linux/amd64`. Add `linux/arm64` with:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
```

`GET /` answers 200 when `dist/index.html` is present. The health check
uses that request.
