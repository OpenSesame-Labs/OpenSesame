# Identity API (@opensesame/control-plane) on port 8788.
# Context is the repository root:
#   docker build -f ops/containers/control-plane/Dockerfile -t control-plane:local .
# CI publishes linux/amd64. arm64: docker buildx build --platform linux/amd64,linux/arm64
# The process stays stopped until the operator env in the README is set.
#
# Proof builds must fit the workflow's 10 minute cap on cold and warm cache
# (docs/operators/ghcr-images.md). Two structural rules keep them there:
# - Production dependencies only. Nothing here runs a dev `npm ci`; the retired
#   Debian build stage paid for one with a full toolchain and discarded it.
# - Dependency layers are keyed on npm manifests alone. The manifests stage
#   prunes the context to what `npm ci` reads, and `COPY --from` keys its cache
#   on the copied content, not on the chain that produced it: a feature-branch
#   workflow_dispatch whose lockfile matches main reuses main's warm layers and
#   skips `npm ci` instead of rebuilding and re-exporting node_modules layers.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS manifests
WORKDIR /src
COPY . .
# Keep the root manifests, the patch inputs, and every workspace package.json
# the lockfile must stay in sync with. `npm ci` reads nothing else. The
# workspace roots mirror the workspaces globs in the root package.json.
RUN find apps packages examples tests tools -type f ! -name package.json -delete \
  && find apps packages examples tests tools -type d -empty -delete \
  && find . -mindepth 1 -maxdepth 1 \
    ! -name package.json ! -name package-lock.json ! -name patches \
    ! -name apps ! -name packages ! -name examples ! -name tests ! -name tools \
    -exec rm -rf -- {} +

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime-deps
WORKDIR /src
COPY --from=manifests /src ./
# Production runtime only: no dev toolchains or nested lockfiles in node_modules.
# The cache mount shares npm's download cache between the two installs.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --ignore-scripts \
  && npm install --no-save --ignore-scripts tsx@4.23.15 \
  && find node_modules -name '.package-lock.json' -delete \
  && rm -rf node_modules/@typescript node_modules/typescript
# Sources arrive after the dependency layers: editing them cannot invalidate
# the install above, and `COPY packages ./packages` merges over the workspace
# manifests already in place.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
COPY tests/redteam ./tests/redteam
COPY tests/visual-contract ./tests/visual-contract
COPY tests/fuzz/jazzer ./tests/fuzz/jazzer
COPY tools/mock-upstream-idp ./tools/mock-upstream-idp
COPY tools/oxlint/anti-slop ./tools/oxlint/anti-slop
# Alpine runtime: no Debian dpkg/status for OSV container scans.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN adduser -D -u 10001 app
WORKDIR /src
COPY --from=runtime-deps --chown=10001:10001 /src/package.json /src/package-lock.json ./
COPY --from=runtime-deps --chown=10001:10001 /src/node_modules ./node_modules
COPY --from=runtime-deps --chown=10001:10001 /src/packages ./packages
COPY --from=runtime-deps --chown=10001:10001 /src/apps ./apps
COPY --from=runtime-deps --chown=10001:10001 /src/examples ./examples
COPY --from=runtime-deps --chown=10001:10001 /src/tests/redteam ./tests/redteam
COPY --from=runtime-deps --chown=10001:10001 /src/tests/visual-contract ./tests/visual-contract
COPY --from=runtime-deps --chown=10001:10001 /src/tests/fuzz/jazzer ./tests/fuzz/jazzer
COPY --from=runtime-deps --chown=10001:10001 /src/tools/mock-upstream-idp ./tools/mock-upstream-idp
COPY --from=runtime-deps --chown=10001:10001 /src/tools/oxlint/anti-slop ./tools/oxlint/anti-slop
COPY --from=runtime-deps --chown=10001:10001 /src/tsconfig.base.json ./tsconfig.base.json
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
