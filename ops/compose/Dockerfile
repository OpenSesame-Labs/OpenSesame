# The one native binary. Every native role is a subcommand of it:
# `opensesame host run` (Host API), `opensesame worker run`, `opensesame daemon run`.
FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS chef
RUN apt-get update \
  && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config \
  && rm -rf /var/lib/apt/lists/* \
  && cargo install cargo-chef --locked
WORKDIR /src
COPY rust-toolchain.toml rust-toolchain.toml

ENV CARGO_PROFILE_RELEASE_LTO=false

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
# Optional bridges, off unless asked for, e.g.
# `docker build --build-arg OPENSESAME_FEATURES=bitwarden-compat` (ADR 0148).
ARG OPENSESAME_FEATURES=""
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,target=/src/target,sharing=locked \
  cargo chef cook --release --recipe-path recipe.json -p opensesame-cli --features "${OPENSESAME_FEATURES}"
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,target=/src/target,sharing=locked \
  cargo build --release -p opensesame-cli --features "${OPENSESAME_FEATURES}" \
  && install -m 0755 target/release/opensesame /usr/local/bin/opensesame

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN useradd -u 10001 -m app \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/opensesame \
  && chown 10001:10001 /var/lib/opensesame
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
