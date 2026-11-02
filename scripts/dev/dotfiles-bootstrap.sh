#!/usr/bin/env bash
# Idempotent, rootless personal-dotfiles bootstrap.
#
# Clones DOTFILES_REPO over anonymous HTTPS. The default is Tyler Kendrick's
# public dotfiles. GitHub CLI, GitHub tokens, credential helpers, and global
# git config (including url.insteadOf token rewrites) are not used. When the
# clone fails, this script prints a notice and exits 1.
set -euo pipefail

repo="${DOTFILES_REPO:-https://github.com/Tyler-R-Kendrick/dotfiles.git}"

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

tree=""
if command -v git >/dev/null 2>&1 && [[ -d "${dest}/.git" ]]; then
  if git_anonymous -C "${dest}" fetch --depth 1 origin \
    && git_anonymous -C "${dest}" reset --hard FETCH_HEAD \
    && [[ -f "${dest}/install.sh" ]]; then
    tree="${dest}"
  elif [[ -f "${dest}/install.sh" ]]; then
    printf 'dotfiles-bootstrap: refresh failed; using existing checkout\n' >&2
    tree="${dest}"
  fi
fi

if [[ -z "${tree}" ]]; then
  rm -rf -- "${dest}"
  mkdir -p "$(dirname "${dest}")"
  if command -v git >/dev/null 2>&1 \
    && git_anonymous clone --depth 1 -- "${repo}" "${dest}" \
    && [[ -f "${dest}/install.sh" ]]; then
    tree="${dest}"
  else
    rm -rf -- "${dest}"
    printf 'dotfiles-bootstrap: clone of %s failed.\n' "${repo}" >&2
    printf 'dotfiles-bootstrap: anonymous HTTPS only (GIT_TERMINAL_PROMPT=0; no gh, GitHub token, or credential helper).\n' >&2
    printf 'dotfiles-bootstrap: publish that repository with install.sh at its root, or set DOTFILES_REPO to a reachable git URL.\n' >&2
    exit 1
  fi
fi

bash "${tree}/install.sh"
