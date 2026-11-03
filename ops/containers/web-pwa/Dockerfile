# Static Pages PWA plus scripts/release/pages-pwa-serve.mjs.
# Context is the repository root:
#   docker build -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
# Default target (amd64 matrix): build on BUILDPLATFORM, runtime follows
# TARGETPLATFORM. npm ci, the Pages build, and prepare-pages-release.mjs
# stay in the build stage only.
#   docker buildx build --platform linux/amd64 \
#     -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
# Arm64 fast path (--target runtime-from-prebuilt): pull PREBUILT_IMAGE as
# linux/amd64 and copy /opt/opensesame-web-pwa into the same node runtime.
#   docker buildx build --platform linux/arm64 --target runtime-from-prebuilt \
#     --build-arg PREBUILT_IMAGE=<published web-pwa image> \
#     -f ops/containers/web-pwa/Dockerfile -t web-pwa:local .
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci
ARG VERSION=0.0.0-local
ENV VERSION=${VERSION} \
  NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build -w @opensesame/pages \
  && node scripts/release/prepare-pages-release.mjs
ARG PREBUILT_IMAGE
FROM --platform=linux/amd64 ${PREBUILT_IMAGE} AS prebuilt
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime-from-prebuilt
RUN useradd -u 10001 -m app
WORKDIR /opt/opensesame-web-pwa
COPY --from=prebuilt --chown=10001:10001 /opt/opensesame-web-pwa/ ./
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="web-pwa" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
ENV HOST=0.0.0.0 \
  PORT=5180
USER 10001
EXPOSE 5180
ENTRYPOINT ["node", "bin/serve.mjs"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5180/').then((response)=>process.exit(response.status===200?0:1)).catch(()=>process.exit(1))"]
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN useradd -u 10001 -m app
WORKDIR /opt/opensesame-web-pwa
COPY --from=build --chown=10001:10001 /src/apps/pages/release/ ./
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="web-pwa" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
ENV HOST=0.0.0.0 \
  PORT=5180
USER 10001
EXPOSE 5180
ENTRYPOINT ["node", "bin/serve.mjs"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5180/').then((response)=>process.exit(response.status===200?0:1)).catch(()=>process.exit(1))"]
