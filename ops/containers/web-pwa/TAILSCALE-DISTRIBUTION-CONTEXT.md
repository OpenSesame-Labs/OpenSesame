# Tailscale distribution cache in the web-pwa image build

## Cache path the build stage must see

`loadTailscaleAssets` in `apps/pages/scripts/tailscale-wasm-assets.mjs` calls
`prepareNativeDistribution` with the repository root and the two pins from
`apps/pages/src/lib/capabilities/tailscale-artifacts.json`:
`manifest.native.sourceMetadataSha256` and `manifest.native.manifestSha256`.

`nativeDistributionDirectory` joins those pins onto the repository root:

```text
<repositoryRoot>/.cache/pwa-tailscale-native-http/distributions/<sourceMetadataSha256>/<manifestSha256>/
```

That is the on-disk tree CI restores, relative to the checkout root. The
image build stage uses `WORKDIR /src` and `COPY . .`. The asset script is
copied to `/src/apps/pages/scripts/tailscale-wasm-assets.mjs`, so `../../..`
resolves to `/src`. Inside that stage the same functions require:

```text
/src/.cache/pwa-tailscale-native-http/distributions/<sourceMetadataSha256>/<manifestSha256>/
```

`prepare` treats the directory as a cache hit when `lstat` succeeds
(`present`). It then returns `readNativeDistribution` for `manifestSha256`
and does not call `assertNativeColdBuildHost`. `loadTailscaleAssets` also
requires the returned source and compiler commits and the asset map to match
`TAILSCALE_ASSETS`, including the pinned wasm, runtime, and native HTTP
digests.

## Why `web-pwa-arm64` still cold-builds after a green restore

The GHCR build context is the repository root (`docker build -f
ops/containers/web-pwa/Dockerfile .`). `.dockerignore` is applied to that
context before `COPY . .`. The `.cache` rule removes
`.cache/pwa-tailscale-native-http/` from the context, so the restored
directory is absent at `/src/.cache/...`.

The artifact restore writes the runner checkout. The container filesystem is
a separate tree, populated only from the filtered context. With the
distribution directory missing, `prepare` takes the cold path and
`assertNativeColdBuildHost` throws:

```text
Cold native WASM preparation requires the pinned Linux AMD64 build host
```

The arm64 publish runs that check in the `build` stage (`npm run build -w
@opensesame/pages` on the default `runtime` target). That stage follows
`BUILDPLATFORM`. On the arm64 job, Node reports `process.arch !== "x64"`, so
the pinned Linux AMD64 compiler is refused. A verified distribution cache is
host-independent and is the path that stage can accept. The
`runtime-from-prebuilt` target copies `/opt/opensesame-web-pwa` from
`PREBUILT_IMAGE` and does not run this preparation.

## Primary fix lever

Change the `.cache` rule in `.dockerignore`.

That rule is what keeps the restored distribution out of the build context.
`ops/containers/web-pwa/Dockerfile` already has `COPY . .`. Once `.cache` no
longer excludes `.cache/pwa-tailscale-native-http/distributions/`, that copy
places the tree at `/src/.cache/...` and `prepareNativeDistribution` reads
it. An explicit `COPY` of the cache path is not a substitute: BuildKit never
sends a dockerignored path, so the copy source is missing from the context.
