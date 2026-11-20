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

# gcompat + libstdc++ run glibc-linked mise artifacts (go, hurl).
# Node musl pins: official nodejs.org linux-x64-musl, unofficial-builds
# linux-arm64-musl. Temurin publishes an Alpine JDK for x64 only. Apple
# Silicon installs openjdk17 from apk and skips mise's java tool.
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

# Temurin publishes no Alpine/musl aarch64 JDK, so mise.lock has no
# linux-arm64-musl Java asset. On Apple Silicon, install Alpine openjdk17
# before `mise install --locked` and skip mise's java tool. Without that
# skip, locked install fails closed on the missing asset. linux-x64 keeps
# the Temurin Alpine JDK.
ARG TARGETARCH
RUN set -eu; \
  arch="${TARGETARCH:-}"; \
  if [ -z "$arch" ]; then \
    case "$(uname -m)" in \
      aarch64|arm64) arch=arm64 ;; \
      *) arch=amd64 ;; \
    esac; \
  fi; \
  if [ "$arch" != "arm64" ]; then \
    exit 0; \
  fi; \
  apk add --no-cache openjdk17; \
  jdk=/usr/lib/jvm/java-17-openjdk; \
  test -x "$jdk/bin/java"; \
  ln -sfn "$jdk" /usr/lib/jvm/default-jvm; \
  for cmd in java javac jar javadoc jlink keytool; do \
    if [ -x "$jdk/bin/$cmd" ]; then \
      ln -sfn "$jdk/bin/$cmd" "/usr/local/bin/$cmd"; \
    fi; \
  done; \
  printf '%s\n' java > /etc/mise-disable-tools; \
  mkdir -p /usr/local/libexec; \
  mv /usr/local/bin/mise /usr/local/libexec/mise; \
  cat > /usr/local/bin/mise <<'EOF'
#!/bin/sh
if [ -z "${MISE_DISABLE_TOOLS:-}" ] && [ -s /etc/mise-disable-tools ]; then
  MISE_DISABLE_TOOLS=$(tr -d '[:space:]' < /etc/mise-disable-tools)
  export MISE_DISABLE_TOOLS
fi
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/lib/jvm/java-17-openjdk/bin/java ]; then
  export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
fi
exec /usr/local/libexec/mise "$@"
EOF
  chmod 0755 /usr/local/bin/mise; \
  cat >> /etc/profile.d/mise.sh <<'EOF'
if [ -x /usr/lib/jvm/java-17-openjdk/bin/java ]; then
  export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
  case ":${PATH}:" in
    *:"${JAVA_HOME}/bin":*) ;;
    *) PATH="${JAVA_HOME}/bin:${PATH}" ;;
  esac
  export PATH
fi
EOF

USER vscode
