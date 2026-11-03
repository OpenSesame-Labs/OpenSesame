# Client CLI image

`ghcr.io/opensesame-labs/cli` is the published `@opensesame/cli` bundle
(`opensesame` on `PATH` inside npm; this image runs `node dist/bin.js`).
The native host binary is the `opensesame` image from `ops/compose/Dockerfile`.

```bash
docker build -f ops/containers/cli/Dockerfile -t cli:local .
docker run --rm cli:local --version
```

The build context is the repository root. The image runs as uid `10001`.
`VERSION` (default `0.0.0-local`) is the OCI version label and the staged
package version. CI publishes `linux/amd64`. Build `linux/arm64` as well
with `docker buildx build --platform linux/amd64,linux/arm64` when a
multi-arch builder is available.

`npm install --ignore-scripts` does not download the `agent-browser`
browser. Commands that need it belong in a derived image.
