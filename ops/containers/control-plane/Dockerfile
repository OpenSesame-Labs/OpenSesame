# Identity API (@opensesame/control-plane) on port 8788.
# Context is the repository root:
#   docker build -f ops/containers/control-plane/Dockerfile -t control-plane:local .
# CI publishes linux/amd64. arm64: docker buildx build --platform linux/amd64,linux/arm64
# The process stays stopped until the operator env in the README is set.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN useradd -u 10001 -m app
WORKDIR /src
COPY --from=build --chown=10001:10001 /src/package.json /src/package-lock.json ./
COPY --from=build --chown=10001:10001 /src/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /src/packages ./packages
COPY --from=build --chown=10001:10001 /src/tools ./tools
COPY --from=build --chown=10001:10001 /src/tsconfig.base.json ./tsconfig.base.json
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="control-plane" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
ENV OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0 \
  OPENSESAME_CONTROL_PLANE_PORT=8788 \
  OPENSESAME_ALLOW_NONLOCAL=1
USER 10001
EXPOSE 8788
ENTRYPOINT ["node", "--import", "tsx", "packages/control-plane/src/server.ts"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/v1/health/live').then((response)=>process.exit(response.status===200?0:1)).catch(()=>process.exit(1))"]
