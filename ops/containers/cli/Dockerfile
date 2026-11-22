# Client CLI (@opensesame/cli release layout).
# Context is the repository root:
#   docker build -f ops/containers/cli/Dockerfile -t cli:local .
# CI publishes linux/amd64. arm64: docker buildx build --platform linux/amd64,linux/arm64
# The native host binary is ghcr.io/opensesame-labs/opensesame, not this image.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts
ARG VERSION=0.0.0-local
ENV CLI_RELEASE_PACK=1 \
  VERSION=${VERSION}
RUN npm run build -w @opensesame/cli \
  && node scripts/release/prepare-cli-release.mjs
# Alpine runtime: no Debian dpkg/status for OSV container scans.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN adduser -D -u 10001 app
WORKDIR /opt/opensesame-cli
COPY --from=build /src/packages/cli/release/ ./
# Committed shrinkwrap for the release manifest from prepare-cli-release.mjs.
# package-lock.json is gitignored; agent-browser's install script downloads a browser.
COPY ops/containers/cli/npm-shrinkwrap.json ./npm-shrinkwrap.json
RUN npm ci --omit=dev --ignore-scripts \
  && find node_modules -name '.package-lock.json' -delete \
  && rm -rf node_modules/@typescript node_modules/typescript \
  && chown -R app:app /opt/opensesame-cli
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="cli" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
USER 10001
ENTRYPOINT ["node", "dist/bin.js"]