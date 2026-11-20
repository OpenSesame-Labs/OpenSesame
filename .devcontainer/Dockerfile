# Devcontainer image for OpenSesame.
# Alpine base (no Debian dpkg/status for OSV devcontainer scans).
# Rust, Node, Go, Java, and Playwright come from `mise install --locked` only.
# updateContentCommand runs `mise install --locked`, which installs the tools
# pinned in the workspace mise.toml and mise.lock.
#
# ghcr.io/devcontainers-extra/features/mise is not used. Its gh-release asset
# filter matches both the glibc and musl tarballs for one mise version.
FROM mcr.microsoft.com/devcontainers/base:alpine@sha256:8be2a2435e239e24b160276c79704c3a4b9d8f261ef669fe99efe15f20cb9ee6

USER root

# Login shells reset PATH. This puts the mise shims and the user bin back.
# BASH_ENV covers non-interactive bash. Docker ENV PATH covers other shells.
RUN cat > /etc/profile.d/mise.sh <<'EOF'
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
case ":${PATH}:" in
  *:/opt/mise/shims:*) ;;
  *) PATH="/opt/mise/shims:${PATH}" ;;
esac
if [ -n "${HOME:-}" ]; then
  case ":${PATH}:" in
    *:"${HOME}/.local/bin":*) ;;
    *) PATH="${HOME}/.local/bin:${PATH}" ;;
  esac
fi
export PATH
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_DIR="${HOME}/.cache/packages/cargo-target"
  export CARGO_TARGET_DIR
fi
EOF

ENV MISE_DATA_DIR=/opt/mise
ENV MISE_CACHE_DIR=/opt/mise/cache
ENV MISE_CARGO_HOME=/opt/mise/cargo
ENV MISE_RUSTUP_HOME=/opt/mise/rustup
ENV CARGO_HOME=/opt/mise/cargo
ENV RUSTUP_HOME=/opt/mise/rustup
ENV BASH_ENV=/etc/profile.d/mise.sh
ENV PATH=/opt/mise/shims:/home/vscode/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# gcompat + libstdc++ run glibc-linked mise toolchains (node, go, temurin, hurl).
RUN apk add --no-cache \
    build-base \
    ca-certificates \
    curl \
    gcompat \
    git \
    libstdc++ \
    pkgconf \
    python3

# Pinned GitHub release tarball (musl build for Alpine). Same MISE_VERSION as
# scripts/lib/mise-pins.sh; musl digests differ from glibc used on GitHub-hosted
# runners. The digest is checked before extraction.
ARG MISE_VERSION=2026.10.18
ARG MISE_SHA256_LINUX_X64_MUSL=bb2f31a377789e85df9358f23aaadb4283e2d760cf657ca7449856f92c4230c4
ARG MISE_SHA256_LINUX_ARM64_MUSL=88bbc1480e196c45c67194b653a08170b9e45e6573e5036f643f288eee95120e

RUN set -eu; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) mise_target="linux-x64-musl"; mise_sha="${MISE_SHA256_LINUX_X64_MUSL}" ;; \
    aarch64) mise_target="linux-arm64-musl"; mise_sha="${MISE_SHA256_LINUX_ARM64_MUSL}" ;; \
    *) echo "unsupported mise architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  archive="mise-v${MISE_VERSION}-${mise_target}.tar.gz"; \
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --show-error --silent --location \
    --output "/tmp/${archive}" \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${archive}"; \
  echo "${mise_sha}  /tmp/${archive}" | sha256sum -c --strict; \
  tar -xzf "/tmp/${archive}" -C /tmp mise/bin/mise; \
  install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise; \
  rm -rf "/tmp/${archive}" /tmp/mise; \
  mise --version; \
  mkdir -p /opt/mise; \
  chown -R vscode:vscode /opt/mise

USER vscode