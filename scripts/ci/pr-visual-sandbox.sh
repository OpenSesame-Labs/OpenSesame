#!/usr/bin/env bash
# Run only public PR code in a no-network, no-credential, non-root container.
set -euo pipefail

mode="${1:?base, head or capture required}"
workspace="${GITHUB_WORKSPACE:?}"
scratch="${RUNNER_TEMP:?}/pr-visual"
base="${workspace}/base"
head="${workspace}/head"
# The linux/amd64 manifest from Playwright v1.65.0-noble.
image='mcr.microsoft.com/playwright@sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366'
node_binary="${PR_VISUAL_NODE_BINARY:?locked Node executable required}"

for value in "$workspace" "$scratch" "$node_binary"; do
  case "$value" in *','*|*$'\n'*) echo 'unsafe sandbox path' >&2; exit 1 ;; esac
done
if [ ! -f "$node_binary" ] || [ ! -x "$node_binary" ]; then echo 'missing Node executable' >&2; exit 1; fi
if [ "$("$node_binary" -p 'process.versions.node.split(".")[0]')" != 24 ]; then echo 'expected Node 24' >&2; exit 1; fi
if [ "$(id -u)" -eq 0 ]; then echo 'sandbox runner must be non-root' >&2; exit 1; fi
if [[ ! ${PR_VISUAL_BASE_SHA:-} =~ ^[a-f0-9]{40}$ || ! ${PR_VISUAL_HEAD_SHA:-} =~ ^[a-f0-9]{40}$ ]]; then
  echo 'invalid PR revisions' >&2; exit 1
fi
mkdir -p "$scratch"
common=(--rm --network none --user "$(id -u):$(id -g)" --cap-drop ALL
  --security-opt no-new-privileges --read-only --pids-limit 512 --memory 6g --cpus 2
  --shm-size 512m --tmpfs /tmp:rw,exec,nosuid,nodev,size=768m,mode=1777
  --mount "type=bind,source=$node_binary,target=/usr/bin/node,readonly"
  --env HOME=/tmp --env NODE_OPTIONS=--max-old-space-size=4096
  --entrypoint /usr/bin/node)

case "$mode" in
  base|head)
    source="$base"
    if [ "$mode" = head ]; then source="$head"; fi
    out="$scratch/$mode-dist"
    mkdir -p "$out" "$scratch/$mode-root-vite" "$scratch/$mode-page-vite"
    if [ "$mode" = head ]; then
      # Git-tracked node_modules/dist or cache links could redirect a host mount.
      for target in node_modules apps/pages/node_modules apps/pages/dist .cache; do
        if [ -e "$head/$target" ] || [ -L "$head/$target" ]; then echo "unexpected head path: $target" >&2; exit 1; fi
      done
    fi
    for target in node_modules apps/pages/node_modules apps/pages/dist apps/pages/public/security-profile.json .cache/pwa-tailscale-native-http/distributions; do
      if [ "$(realpath -m -- "$source/$target")" != "$source/$target" ]; then
        echo "sandbox path traverses a link: $target" >&2; exit 1
      fi
    done
    mkdir -p "$source/node_modules/.vite-temp" "$source/apps/pages/node_modules/.vite-temp" "$source/apps/pages/dist" "$source/.cache/pwa-tailscale-native-http/distributions"
    cp -- "$source/apps/pages/public/security-profile.json" "$scratch/$mode-security-profile.json"
    deps=(--mount "type=bind,source=$base/node_modules,target=/repo/node_modules,readonly")
    find "$base/apps" "$base/packages" "$base/examples" "$base/tests" "$base/tools" -mindepth 1 -maxdepth 3 -type d -name node_modules -prune -print0 > "$scratch/$mode-dependency-paths"
    while IFS= read -r -d '' dep; do
      relative="${dep#"$base/"}"
      case "$relative" in *','*|*$'\n'*) echo 'unsafe dependency path' >&2; exit 1 ;; esac
      if [ "$mode" = head ]; then
        if [ "$(realpath -m -- "$head/$relative")" != "$head/$relative" ]; then echo "linked dependency path: $relative" >&2; exit 1; fi
        if [ "$relative" != apps/pages/node_modules ] && { [ -e "$head/$relative" ] || [ -L "$head/$relative" ]; }; then
          echo "unexpected head dependency path: $relative" >&2; exit 1
        fi
        mkdir -p "$head/$relative"
      fi
      deps+=(--mount "type=bind,source=$dep,target=/repo/$relative,readonly")
    done < "$scratch/$mode-dependency-paths"
    docker_args=("${common[@]}" --workdir /repo/apps/pages
      --mount "type=bind,source=$source,target=/repo,readonly"
      "${deps[@]}"
      --mount "type=bind,source=$base/.cache/pwa-tailscale-native-http/distributions,target=/repo/.cache/pwa-tailscale-native-http/distributions,readonly"
      --mount "type=bind,source=$out,target=/repo/apps/pages/dist"
      --mount "type=bind,source=$scratch/$mode-security-profile.json,target=/repo/apps/pages/public/security-profile.json"
      --mount "type=bind,source=$scratch/$mode-root-vite,target=/repo/node_modules/.vite-temp"
      --mount "type=bind,source=$scratch/$mode-page-vite,target=/repo/apps/pages/node_modules/.vite-temp"
      --env VITE_BASE=/OpenSesame/ --env OPENSESAME_BUILD_MODE=selective
      --env OPENSESAME_CAPABILITY_PROFILE=capability-profiles/full.json)
    docker run "${docker_args[@]}" "$image" /repo/apps/pages/scripts/security-profile.mjs
    docker run "${docker_args[@]}" "$image" /repo/node_modules/vite/bin/vite.js build --outDir dist --emptyOutDir
    docker run "${docker_args[@]}" "$image" /repo/apps/pages/scripts/build-workers.mjs
    "$node_binary" "$base/scripts/ci/pr-visual-safety.mjs" dist "$out"
    ;;
  capture)
    if [ "$(realpath -m -- "$base/work/evidence")" != "$base/work/evidence" ]; then
      echo 'capture path traverses a link' >&2; exit 1
    fi
    mkdir -p "$scratch/capture" "$base/work/evidence"
    docker run "${common[@]}" --workdir /repo \
      --mount "type=bind,source=$base,target=/repo,readonly" \
      --mount "type=bind,source=$scratch/capture,target=/repo/work/evidence" \
      --mount "type=bind,source=$scratch/base-dist,target=/visual/base,readonly" \
      --mount "type=bind,source=$scratch/head-dist,target=/visual/head,readonly" \
      --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      --env PR_VISUAL_BASE_DIST=/visual/base --env PR_VISUAL_HEAD_DIST=/visual/head \
      --env "PR_VISUAL_BASE_SHA=$PR_VISUAL_BASE_SHA" --env "PR_VISUAL_HEAD_SHA=$PR_VISUAL_HEAD_SHA" \
      "$image" /repo/scripts/ci/pr-visual-evidence.mjs
    "$node_binary" "$base/scripts/ci/pr-visual-safety.mjs" artifact "$scratch/capture/pr-visual/artifact"
    ;;
  *) echo 'expected base, head or capture' >&2; exit 2 ;;
esac
