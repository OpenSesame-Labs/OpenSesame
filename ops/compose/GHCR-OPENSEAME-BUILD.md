# opensesame amd64 GHCR build duration

Diagnosis of CD GHCR publish run [41767491723](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/41767491723) on `main` at `faf0343a414691304454bf1aa14aa5efb1f2f6ea`. The run was cancelled at the 10 minute job cap. Leave `timeout-minutes` at 10. `scripts/lib/ci-ghcr-publish.test.mjs` requires every timeout in `.github/workflows/cd-ghcr-publish.yml` to be 10 and rejects 45 and 120.

## Timeline (`opensesame-amd64`, job 126369217654)

UTC, 2026-11-04. Runner `ubuntu-latest`, platform `linux/amd64`, cache scope `opensesame-amd64`.

| Time | Event |
| --- | --- |
| 03:30:02 | Workflow start, push to `main`. |
| 03:30:05 | Job start. |
| 03:30:07–03:30:13 | Sparse checkout, `fetch-depth: 1`. |
| 03:30:13–03:30:17 | Dockerfile check, tags, GHCR login, Buildx. BuildKit v0.34.2. |
| 03:30:17 | Build. `cache-from` / `cache-to` `type=gha,mode=max`. `provenance: true`. |
| 03:30:18 | `#10` imported GHA cache manifest `gha:5237569088074032091` in 0.1s. |
| 03:30:21 | `#7` build context 82.06MB in 2.2s. |
| 03:30:21–03:30:34 | `#11`–`#13` chef `CACHED` (`apt` + `cargo install cargo-chef`, `WORKDIR`, `rust-toolchain.toml`). `#13` blob fill finished at 12.7s. |
| 03:30:34–03:30:39 | `#14` planner `COPY . .` 3.0s. `#15` `cargo chef prepare` 2.8s, including a rustup channel sync. |
| 03:30:39 | `#16` `COPY recipe.json` `CACHED`. |
| 03:30:39–03:30:41 | `#17` cook extracted one 43.56MB blob in 1.8s. No `CACHED` line and no cargo compile log. |
| 03:30:41–03:30:43 | `#18` `COPY . .` 1.9s. |
| 03:30:43–03:39:58 | `#19` `cargo build --release -p opensesame-cli`. `Finished release profile [optimized] target(s) in 9m 14s`. Step `DONE 554.4s`. |
| 03:39:58–03:40:00 | `#20` runtime `apt` layer `CACHED`. `#21` copy of the binary, 0.2s. |
| 03:40:00–03:40:05 | `#22` export, provenance attestation manifest, and push. `DONE 5.6s`. Tag `ghcr.io/opensesame-labs/opensesame:sha-faf0343a414691304454bf1aa14aa5efb1f2f6ea-amd64` was pushed. |
| 03:40:05.645 | `#24` `exporting to GitHub Actions Cache`, `preparing build cache for export`. |
| 03:40:05.734 | `The operation was canceled.` |
| 03:40:32 | Job conclusion `cancelled`. `manifests` skipped: `needs.images.result == 'success'` is false, so `:next` and `:sha-*` were not published. |

Sibling `opensesame-arm64` (job 126369217809) succeeded on the same run. Same cache shape. `#19` finished in 6m 50s. `#24` cache export `DONE 17.6s` (prepare 5.4s).

## GHA cache: chef, cook, final build

| Stage | Result |
| --- | --- |
| Chef (`#11`–`#13`) | Hit. The log prints `CACHED`. |
| Cook (`#17`) | Layer restore. 43.56MB extracted in 1.8s, and `cargo chef cook` did not compile. |
| Final build (`#19`) | Miss. Cold `cargo build --release`: crates.io index update, crate downloads, then 9m 14s. |

The cook and final `RUN`s mount `/usr/local/cargo/registry`, `/usr/local/cargo/git`, and `/src/target` (`ops/compose/Dockerfile`). Those mounts are not image layers. `mode=max` restored the small cook layer and left the mounts empty, so `#19` compiled from scratch. Planner `#14` and `#15` ran. `#16` shows `recipe.json` matched the previous cache entry.

## Ranked levers

About 38s elapse from job start to `#19`. The release compile is 554s. Image export adds about 7s and lands on the 10:00 mark (push finished at 03:40:05.645; cancel at 03:40:05.734). The arm64 twin shows this `mode=max` export costs about 18s. That tail has to come out of the compile.

1. **Docker layer order (cache mounts).** Highest. Chef, then prepare, then cook, then `COPY` source, then build is already the cargo-chef order. The mounts keep `target/` out of the GHA layer cache, so a restored cook layer cannot make `#19` incremental. Put the dependency artifacts in a layer the final `cargo build` inherits: drop the mounts, or copy `target/` out of the mount before the `RUN` ends. This is the lever that can take minutes off the 9m 14s compile.

2. **Cache export mode.** The job died in `#24` with `cache-to: type=gha,mode=max,scope=opensesame-amd64`. On arm64 that export took 17.6s, which is the overrun (the cancel is 89ms after export starts). `mode=min`, or omitting `cache-to` on this row, removes that tail. This `mode=max` export did not refill the cargo mounts, so it does not buy the next compile. If lever 1 puts `target/` in a layer, keep the export on `min` or on a cook-only scope so that fat layer is not repacked on the deadline. The test locks `cache-to: type=gha,mode=max,scope=${{ matrix.id }}`.

3. **Checkout context size.** Context transfer was 82.06MB in 2.2s, planner `COPY` 3.0s, builder `COPY` 1.9s. The checkout step was about 6s. The `images` sparse-checkout still lists apps, packages, examples, patches, scripts, tools, spec, marketplace, and tests. A narrower checkout and `.dockerignore` save seconds on the critical path and shrink the planner layer a `mode=max` export would upload. A cold release compile stays the same length.

4. **Provenance.** `provenance: true` wrote the attestation manifest inside `#22`. That step completed (`DONE 5.6s`) before the cancel. Disabling it saves sub-seconds inside an export that already finished. The test sets `provenance` from `PUBLISH_GHCR == 'true'`.

5. **Drop the arm64 matrix row.** Tyler approved opensesame `linux/amd64` only. Arm64 is another runner and it finished this run, so the amd64 clock does not move. The manifest row still lists `platforms: amd64 arm64` and runs only when every `images` cell succeeds. A later green amd64 job can publish `:next` and `:sha-*` once that list is amd64 only. The test locks `id: opensesame-arm64`, `runner: ubuntu-24.04-arm`, and `platforms: amd64 arm64`.

The amd64 image push succeeded. `:next` did not move, because the manifest job was skipped.
