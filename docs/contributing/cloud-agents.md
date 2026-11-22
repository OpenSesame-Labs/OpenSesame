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

A hosted environment bootstraps this repository with `mise install --locked`
and `mise run deps`; it does not execute personal repositories during a
devcontainer lifecycle hook. A contributor may explicitly run
`scripts/dev/dotfiles-bootstrap.sh` for personal mise and Grok setup. That
manual command clones with anonymous HTTPS from `DOTFILES_REPO`, default
`https://github.com/Tyler-R-Kendrick/dotfiles.git`; the script pins a reviewed
commit and the exact `install.sh` SHA-256; a custom repository must also set
`DOTFILES_REF` and `DOTFILES_INSTALL_SHA256`; no GitHub token and no credential
helper; a failed or mismatched checkout stops the manual bootstrap. Dependency
setup remains fingerprinted `npm ci` via
`scripts/dev/install-dependencies.sh`, followed by `cargo fetch`. Prefer the
shared cargo target dir documented in
[shipping](shipping.md) when compiling Rust.

## Devcontainer

`.devcontainer/devcontainer.json` builds on the pinned Rust devcontainer
image. The image installs a checksum-pinned mise release. It does not use
a Node feature. `updateContentCommand` and
`postCreateCommand` install the locked toolchain from `mise.toml` and
`mise.lock` (`mise install --locked`), then run `mise run deps` (`npm ci`).
Personal dotfiles remain an explicit contributor action.
`postCreateCommand` also runs `scripts/dev/setup-hooks.sh`.
`postStartCommand` still runs `scripts/dev/install-agent-skills.sh`.
