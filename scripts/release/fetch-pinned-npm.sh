#!/usr/bin/env bash
# Download and verify the pinned npm CLI before publication credentials exist.
set -euo pipefail

unset ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  NODE_AUTH_TOKEN NPM_TOKEN NPM_TOKEN_INPUT GH_TOKEN GITHUB_TOKEN \
  NODE_OPTIONS NODE_PATH NPM_CONFIG_USERCONFIG
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
npm_dir="$(mktemp -d "${RUNNER_TEMP:?}/opensesame-npm-XXXXXXXX")"
npm_archive="${npm_dir}/npm.tgz"
prepared=0
cleanup() {
  rm -f -- "$npm_archive"
  if [[ "$prepared" != 1 ]]; then rm -rf -- "$npm_dir"; fi
}
trap cleanup EXIT

/usr/bin/curl --disable --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --max-time 60 \
  --max-filesize 16777216 --output "$npm_archive" \
  https://registry.npmjs.org/npm/-/npm-11.21.1.tgz
npm_cli="$(node "${script_dir}/prepare-npm-cli.mjs" \
  "$npm_archive" "${npm_dir}/extracted")"
prepared=1
printf '%s\n' "$npm_cli"
