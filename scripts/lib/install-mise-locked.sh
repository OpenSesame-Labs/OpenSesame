#!/usr/bin/env bash
# Install the pinned mise binary, then `mise install --locked` for the requested tools.
# The binary is the GitHub release tarball pinned in scripts/lib/mise-pins.sh
# (same version and linux digests as the Cursor and devcontainer images).
# The digest is checked before extraction. This does not ask GitHub for jdx/mise
# release metadata.
#
# Usage: install-mise-locked.sh node@24
# Tool arguments match mise-action install_args (node or node@24 on CD npm CLI).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf '%s\n' "usage: install-mise-locked.sh <tool[@version]>..." >&2
  exit 1
fi

for tool in "$@"; do
  # Refuse shell metacharacters. CD passes node or node@24.
  if [[ -z "$tool" || "$tool" == *[!A-Za-z0-9_.:@=-]* ]]; then
    printf 'refusing tool request: %s\n' "$tool" >&2
    exit 1
  fi
done

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=mise-pins.sh
source "${script_dir}/mise-pins.sh"

: "${MISE_VERSION:?}"
: "${MISE_SHA256_LINUX_X64:?}"
: "${MISE_SHA256_LINUX_ARM64:?}"
: "${HOME:?}"

if [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
  root="$GITHUB_WORKSPACE"
else
  root=$(CDPATH= cd -- "${script_dir}/../.." && pwd)
fi

if [[ ! -f "${root}/mise.toml" || ! -f "${root}/mise.lock" ]]; then
  printf 'missing mise.toml or mise.lock under %s\n' "$root" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    mise_target="linux-x64"
    mise_sha="$MISE_SHA256_LINUX_X64"
    ;;
  aarch64 | arm64)
    mise_target="linux-arm64"
    mise_sha="$MISE_SHA256_LINUX_ARM64"
    ;;
  *)
    printf 'unsupported mise architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

export MISE_DATA_DIR="${MISE_DATA_DIR:-${HOME}/.local/share/mise}"
export MISE_YES=1
mkdir -p "${HOME}/.local/bin" "$MISE_DATA_DIR"

mise_bin="${HOME}/.local/bin/mise"
archive="mise-v${MISE_VERSION}-${mise_target}.tar.gz"
url="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${archive}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive_path="${work}/${archive}"

curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --fail --show-error --silent --location \
  --retry 5 --retry-delay 2 \
  --output "$archive_path" \
  "$url"
printf '%s  %s\n' "$mise_sha" "$archive_path" | sha256sum -c --strict
tar -xzf "$archive_path" -C "$work" mise/bin/mise
install -m 0755 "${work}/mise/bin/mise" "$mise_bin"

# GitHub prepends each GITHUB_PATH line, so the last line is first on PATH.
# Record the binary directory, then the shims directory.
prepend_github_path() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) ;;
    *) PATH="${dir}:${PATH}" ;;
  esac
  export PATH
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$dir" >> "$GITHUB_PATH"
  fi
}

prepend_github_path "${HOME}/.local/bin"
shim_dir="${MISE_DATA_DIR}/shims"
mkdir -p "$shim_dir"
prepend_github_path "$shim_dir"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'MISE_DATA_DIR=%s\n' "$MISE_DATA_DIR" >> "$GITHUB_ENV"
  printf 'MISE_YES=%s\n' "1" >> "$GITHUB_ENV"
fi

cd "$root"
"$mise_bin" trust "${root}/mise.toml"
"$mise_bin" install --locked "$@"
"$mise_bin" reshim

# The mise-action step this replaces exported the [env] table of mise.toml (CARGO_TARGET_DIR,
# RUSTUP_TOOLCHAIN, ...) to later steps, and workflows read it through
# ${{ env.NAME }}. A shim only gives it to its own child process, so export it
# here too. PATH is not written: GITHUB_PATH above already carries it.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  mise_env=$("$mise_bin" env --dotenv)
  while IFS= read -r line; do
    case "$line" in
      "" | PATH=*) ;;
      [A-Za-z_]*=[\"\']*)
        # GITHUB_ENV takes the value literally; a quoted value would keep its quotes.
        printf 'refusing quoted mise env line: %s\n' "${line%%=*}" >&2
        exit 1
        ;;
      [A-Za-z_]*=*) printf '%s\n' "$line" >> "$GITHUB_ENV" ;;
      *)
        printf 'unexpected mise env output\n' >&2
        exit 1
        ;;
    esac
  done <<< "$mise_env"
fi

needs_node=0
for tool in "$@"; do
  case "$tool" in
    node | node@*) needs_node=1 ;;
  esac
done
if [[ "$needs_node" -eq 1 ]]; then
  command -v node >/dev/null
  node -v
  command -v npm >/dev/null
fi
