# Client CLI (@opensesame/cli release layout).
# Context is the repository root:
#   docker build -f ops/containers/cli/Dockerfile -t cli:local .
# CI publishes linux/amd64. arm64: docker buildx build --platform linux/amd64,linux/arm64
# The native host binary is ghcr.io/opensesame-labs/opensesame, not this image.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci
ARG VERSION=0.0.0-local
ENV CLI_RELEASE_PACK=1 \
  VERSION=${VERSION}
RUN npm run build -w @opensesame/cli \
  && node scripts/release/prepare-cli-release.mjs
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN useradd -u 10001 -m app
WORKDIR /opt/opensesame-cli
COPY --from=build /src/packages/cli/release/ ./
# The release manifest depends on agent-browser. Skip its browser download.
RUN npm install --omit=dev --ignore-scripts \
  && chown -R app:app /opt/opensesame-cli
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="cli" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
USER 10001
ENTRYPOINT ["node", "dist/bin.js"]
