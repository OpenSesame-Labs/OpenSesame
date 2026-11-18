# Cloud agent environments

Generic cloud-agent environment notes moved from `AGENTS.md`. Harness-specific
model or subscription routing is intentionally not recorded here; configure it
in the harness, not in the repository.

## Cursor Cloud and other hosted agents

This repository does not ship a hosted-agent environment. The Cursor Cloud
image and bootstrap (`environment.json`, `Dockerfile`, `install.sh`), harness
rules, hooks and MCP definitions live in the OpenSesame Labs dotfiles repo,
not here. Any harness-owned dot folder in a working tree is local output and
is gitignored.

- **Never run `sudo`** in agent commands (see [AGENTS.md](../../AGENTS.md)).
- **Never commit API keys** or other secrets; inject them through the
  harness's secret store.

A hosted environment can set up this repository with `mise install --locked`,
`mise run deps` (fingerprinted `npm ci` via
`scripts/dev/install-dependencies.sh`), and `cargo fetch`. Prefer the shared
cargo target dir documented in [shipping](shipping.md) when compiling Rust.
Personal dotfiles are optional: `bash scripts/dev/dotfiles-bootstrap.sh`
clones `DOTFILES_REPO` over anonymous HTTPS, defaulting to
`https://github.com/Tyler-R-Kendrick/dotfiles.git`, without a GitHub token or
credential helper. It executes the unpinned upstream installer, so run it
explicitly only after choosing to trust that source.

## Devcontainer

`.devcontainer/devcontainer.json` builds on the pinned Rust devcontainer
image. The image installs a checksum-pinned mise release. It does not use
a Node feature. `updateContentCommand` and `postCreateCommand` install the
locked toolchain from `mise.toml` and `mise.lock` (`mise install --locked`),
then run `mise run deps` (`npm ci`). `postCreateCommand` also runs
`scripts/dev/setup-hooks.sh`. The lifecycle does not install personal
dotfiles or third-party skills. After reviewing and choosing to trust the
upstream source, a developer may explicitly run
`bash scripts/dev/dotfiles-bootstrap.sh`, which executes unpinned content.
`npm run skills:review` prints guidance for manually obtaining and reviewing
an immutable skill revision; it performs no installation or updates.
