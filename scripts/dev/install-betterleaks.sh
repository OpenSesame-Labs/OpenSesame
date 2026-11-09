#!/usr/bin/env bash
# Install the pinned Betterleaks release into .tools/bin (git-ignored; no sudo).
#
# One pin for developers and CI. The archive is verified against the SHA-256 in
# this file, which was checked against the release's published checksums.txt.
# To upgrade: change VERSION and every digest below from the new release's
# checksums.txt, then run `npm run audit:betterleaks` and re-triage any new
# findings (a new release can ship new rules).
#
# usage: scripts/dev/install-betterleaks.sh [destination-dir]
set -euo pipefail

VERSION="1.9.0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-$ROOT/.tools/bin}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)         asset="linux_x64";    sha="f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7" ;;
  Linux-aarch64|Linux-arm64) asset="linux_arm64"; sha="1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b" ;;
  Darwin-x86_64)        asset="darwin_x64";   sha="68dfd83458d9e7f90663daa7a81c7f944083b170dae82e4f5f8d0581ed519ef1" ;;
  Darwin-arm64)         asset="darwin_arm64"; sha="83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2" ;;
  *)
    echo "install-betterleaks: no pinned build for $(uname -s)-$(uname -m)." >&2
    echo "  Windows: download the zip from https://github.com/betterleaks/betterleaks/releases/tag/v${VERSION} and verify it." >&2
    exit 1
    ;;
esac

if [[ -x "$DEST/betterleaks" ]] && [[ "$("$DEST/betterleaks" version 2>/dev/null || true)" == "$VERSION" ]]; then
  echo "betterleaks $VERSION already installed at $DEST/betterleaks"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="betterleaks_${VERSION}_${asset}.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}/${archive}" \
  -o "$work/$archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$archive" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)"
fi
[[ "$actual" == "$sha" ]] \
  || { echo "install-betterleaks: checksum mismatch for $archive; refusing to install." >&2; exit 1; }

mkdir -p "$DEST"
tar -xzf "$work/$archive" -C "$work" betterleaks
install -m 0755 "$work/betterleaks" "$DEST/betterleaks"
got="$("$DEST/betterleaks" version)"
[[ "$got" == "$VERSION" ]] || { echo "install-betterleaks: expected $VERSION, got $got" >&2; exit 1; }
echo "installed betterleaks $got at $DEST/betterleaks"
