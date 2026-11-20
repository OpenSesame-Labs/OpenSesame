# The one native binary. Every native role is a subcommand of it:
# `opensesame host run` (Host API), `opensesame worker run`, `opensesame daemon run`.
#
# Two targets share the Alpine runtime below. Only the binary source differs.
# `runtime` is the local path. It keeps the full cargo-chef plan and compile:
#   docker build -f ops/compose/Dockerfile --target runtime -t opensesame:local .
# `runtime-from-prebuilt` is the default target (the last stage). GHCR publish
# does not pass --target, so it builds this stage and does not run cargo. It
# copies ops/compose/prebuilt/opensesame from the build context to
# /usr/local/bin/opensesame with mode 0755. CI writes that binary; it is not
# committed. Leave it out of .dockerignore so the context still contains it.
FROM rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS chef
RUN apt-get update \
  && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config musl-tools \
  && rm -rf /var/lib/apt/lists/* \
  && cargo install cargo-chef --locked
WORKDIR /src
COPY rust-toolchain.toml rust-toolchain.toml
# rust-toolchain.toml selects 1.99.0. Add the musl standard library on that toolchain.
RUN rustup target add x86_64-unknown-linux-musl

ENV CARGO_PROFILE_RELEASE_LTO=false
ENV CARGO_PROFILE_RELEASE_CODEGEN_UNITS=32
# C dependencies (AWS-LC, vendored libdbus, bundled SQLite) are compiled with
# musl-gcc. The same driver links the musl target. mold stays on the gnu
# target; its linker flag breaks this link. These variables are set before COPY . .
# so cargo-chef cook sees them; .cargo/config.toml arrives with the source.
ENV CC_x86_64_unknown_linux_musl=musl-gcc \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
# Optional bridges, off unless asked for, on the local `runtime` target, e.g.
# `docker build --target runtime --build-arg OPENSESAME_FEATURES=bitwarden-compat` (ADR 0148).
ARG OPENSESAME_FEATURES=""
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,target=/src/target,sharing=locked \
  cargo chef cook --release --recipe-path recipe.json -p opensesame-cli --features "${OPENSESAME_FEATURES}" --target x86_64-unknown-linux-musl
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,target=/src/target,sharing=locked \
  cargo build --release -p opensesame-cli --features "${OPENSESAME_FEATURES}" --target x86_64-unknown-linux-musl \
  && install -m 0755 target/x86_64-unknown-linux-musl/release/opensesame /usr/local/bin/opensesame

# Packages, user, and state dir for both runtime targets. No binary yet, so
# the prebuilt target does not depend on the chef compile.
# Alpine 3.24. Both binaries are x86_64-unknown-linux-musl (static), so this
# stage does not install a glibc compatibility layer or libstdc++. libdbus is
# compiled into the binary (dbus crate `vendored` feature, static). Alpine
# dbus-libs is not installed: this binary does not need it.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS alpine-runtime
RUN apk add --no-cache ca-certificates curl \
  && adduser -D -u 10001 app \
  && mkdir -p /var/lib/opensesame \
  && chown 10001:10001 /var/lib/opensesame

# Local compile. Selects the builder binary. Compose uses this target.
FROM alpine-runtime AS runtime
COPY --from=builder /usr/local/bin/opensesame /usr/local/bin/opensesame
# Default inspect version. CD passes --build-arg VERSION from the git tag or 0.0.0-next.
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="opensesame" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
# The published port is the point of this image, so listen on all interfaces.
# Loopback-only stays available by overriding both variables.
ENV OPENSESAME_STATE_DIR=/var/lib/opensesame \
  OPENSESAME_LISTEN=0.0.0.0:8787 \
  OPENSESAME_ALLOW_NONLOCAL=1
VOLUME ["/var/lib/opensesame"]
USER 10001
EXPOSE 8787
ENTRYPOINT ["opensesame"]
# Assumes `host run`. `worker run` and `daemon run` do not serve this URL;
# override the check for those roles.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8787/health/live"]

# Default target. GHCR publish builds this stage. The binary is the CI file
# ops/compose/prebuilt/opensesame, mode 0755, not the chef output.
FROM alpine-runtime AS runtime-from-prebuilt
COPY --chmod=0755 ops/compose/prebuilt/opensesame /usr/local/bin/opensesame
ARG VERSION=0.0.0-local
LABEL org.opencontainers.image.source="https://github.com/OpenSesame-Labs/OpenSesame" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="opensesame" \
  dev.opensesame.env.documentation="https://github.com/OpenSesame-Labs/OpenSesame/blob/main/docs/operators/ghcr-images.md"
ENV OPENSESAME_STATE_DIR=/var/lib/opensesame \
  OPENSESAME_LISTEN=0.0.0.0:8787 \
  OPENSESAME_ALLOW_NONLOCAL=1
VOLUME ["/var/lib/opensesame"]
USER 10001
EXPOSE 8787
ENTRYPOINT ["opensesame"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8787/health/live"]
