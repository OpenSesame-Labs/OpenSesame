#!/usr/bin/env bash
# Idempotent, rootless personal-dotfiles bootstrap.
#
# Clones one reviewed DOTFILES_REPO revision over anonymous HTTPS. The default
# is Tyler Kendrick's public dotfiles at the commit and install.sh digest below.
# A custom repository must supply its own immutable revision and digest.
# GitHub CLI, GitHub tokens, credential helpers, and global git config
# (including url.insteadOf token rewrites) are not used. When verification or
# cloning fails, this script prints a notice and exits 1.
set -euo pipefail

default_repo="https://github.com/Tyler-R-Kendrick/dotfiles.git"
default_ref="720ba701a41a3bd6cfc086141067d7a1003a0392"
default_install_sha256="7d3c74db2b469c73de388957aeb52699998cfe3a89c874a3da83a6149cf3886e"
repo="${DOTFILES_REPO:-${default_repo}}"

if [[ "${repo}" == "${default_repo}" ]]; then
  ref="${DOTFILES_REF:-${default_ref}}"
  install_sha256="${DOTFILES_INSTALL_SHA256:-${default_install_sha256}}"
else
  ref="${DOTFILES_REF:-}"
  install_sha256="${DOTFILES_INSTALL_SHA256:-}"
fi

if [[ ! "${ref}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'dotfiles-bootstrap: DOTFILES_REF must be a full lowercase commit id\n' >&2
  exit 1
fi
if [[ ! "${install_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'dotfiles-bootstrap: DOTFILES_INSTALL_SHA256 must be a lowercase SHA-256 digest\n' >&2
  exit 1
fi

if [[ -x /usr/bin/sha256sum ]]; then
  sha256_bin=/usr/bin/sha256sum
elif [[ -x /bin/sha256sum ]]; then
  sha256_bin=/bin/sha256sum
else
  printf 'dotfiles-bootstrap: a system sha256sum is required\n' >&2
  exit 1
fi

if [[ -z "${HOME:-}" || ! -d "${HOME}" || ! -w "${HOME}" ]]; then
  printf 'dotfiles-bootstrap: HOME must be a writable directory\n' >&2
  exit 1
fi

dest="${HOME}/.local/share/opensesame/tyler-dotfiles"
case "${dest}" in
  "${HOME}/"*) ;;
  *)
    printf 'dotfiles-bootstrap: checkout must stay under HOME\n' >&2
    exit 1
    ;;
esac

case "${repo}" in
  git@* | ssh://* | *://*@*)
    printf 'dotfiles-bootstrap: refusing %s\n' "${repo}" >&2
    printf 'dotfiles-bootstrap: clone is anonymous HTTPS only (no SSH, no embedded credentials).\n' >&2
    exit 1
    ;;
esac

export GIT_TERMINAL_PROMPT=0

# install.sh points MISE_DATA_DIR at the user data dir. A project mise shim
# follows that variable, so prefer the real Node binary when the locked
# toolchain is already installed.
if command -v mise >/dev/null 2>&1; then
  node_prefix=""
  if command -v timeout >/dev/null 2>&1; then
    node_prefix="$(timeout 10 mise where node 2>/dev/null || true)"
  else
    node_prefix="$(mise where node 2>/dev/null || true)"
  fi
  if [[ -n "${node_prefix}" && -x "${node_prefix}/bin/node" ]]; then
    PATH="${node_prefix}/bin:${PATH}"
  fi
fi
mkdir -p "${HOME}/.local/bin"
case ":${PATH}:" in
  *:"${HOME}/.local/bin":*) ;;
  *) PATH="${HOME}/.local/bin:${PATH}" ;;
esac
export PATH

# Anonymous git only. GIT_CONFIG_GLOBAL=/dev/null skips ~/.gitconfig and
# $XDG_CONFIG_HOME/git/config, so a url.insteadOf rule cannot inject a token.
# An empty credential.helper resets the helper list for this command.
git_anonymous() {
  env \
    -u GITHUB_TOKEN \
    -u GH_TOKEN \
    -u GH_ENTERPRISE_TOKEN \
    -u GITHUB_ENTERPRISE_TOKEN \
    -u GIT_ASKPASS \
    -u SSH_ASKPASS \
    -u GIT_CONFIG_COUNT \
    -u GIT_CONFIG_PARAMETERS \
    GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    git -c credential.helper= -c core.askPass= "$@"
}

verify_tree() {
  local checkout="$1"
  local actual_ref actual_sha256
  [[ -f "${checkout}/install.sh" ]] || return 1
  actual_ref="$(git_anonymous -C "${checkout}" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "${actual_ref}" == "${ref}" ]] || return 1
  actual_sha256="$("${sha256_bin}" "${checkout}/install.sh" | awk '{print $1}')" || return 1
  [[ "${actual_sha256}" == "${install_sha256}" ]]
}

tree=""
if command -v git >/dev/null 2>&1 && [[ -d "${dest}/.git" ]]; then
  if git_anonymous -C "${dest}" fetch --depth 1 origin "${ref}" \
    && [[ "$(git_anonymous -C "${dest}" rev-parse FETCH_HEAD)" == "${ref}" ]] \
    && git_anonymous -C "${dest}" reset --hard "${ref}" \
    && verify_tree "${dest}"; then
    tree="${dest}"
  elif verify_tree "${dest}"; then
    printf 'dotfiles-bootstrap: refresh failed; using the verified pinned checkout\n' >&2
    tree="${dest}"
  fi
fi

if [[ -z "${tree}" ]]; then
  rm -rf -- "${dest}"
  mkdir -p "$(dirname "${dest}")"
  if command -v git >/dev/null 2>&1 \
    && git_anonymous init "${dest}" \
    && git_anonymous -C "${dest}" remote add origin "${repo}" \
    && git_anonymous -C "${dest}" fetch --depth 1 origin "${ref}" \
    && [[ "$(git_anonymous -C "${dest}" rev-parse FETCH_HEAD)" == "${ref}" ]] \
    && git_anonymous -C "${dest}" checkout --detach "${ref}" \
    && verify_tree "${dest}"; then
    tree="${dest}"
  else
    rm -rf -- "${dest}"
    printf 'dotfiles-bootstrap: verified checkout of %s at %s failed.\n' "${repo}" "${ref}" >&2
    printf 'dotfiles-bootstrap: anonymous HTTPS only (GIT_TERMINAL_PROMPT=0; no gh, GitHub token, or credential helper).\n' >&2
    printf 'dotfiles-bootstrap: custom repositories require DOTFILES_REPO, DOTFILES_REF, and DOTFILES_INSTALL_SHA256.\n' >&2
    exit 1
  fi
fi

bash "${tree}/install.sh"
