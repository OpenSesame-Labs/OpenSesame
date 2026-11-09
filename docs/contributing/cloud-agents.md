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

A hosted environment bootstraps this repository the same way a contributor
does: `scripts/dev/dotfiles-bootstrap.sh` (personal mise and Grok, cloned with
anonymous HTTPS from `DOTFILES_REPO`, default
`https://github.com/Tyler-R-Kendrick/dotfiles.git`; no GitHub token and no credential helper; a failed clone
stops the bootstrap), then `mise install --locked` and `mise run deps`
(fingerprinted `npm ci` via `scripts/dev/install-dependencies.sh`), then
`cargo fetch`. Prefer the shared cargo target dir documented in
[shipping](shipping.md) when compiling Rust.

## Devcontainer

`.devcontainer/devcontainer.json` builds on the pinned Rust devcontainer
image. The image installs a checksum-pinned mise release. It does not use
a Node feature. `updateContentCommand` and
`postCreateCommand` install the locked toolchain from `mise.toml` and
`mise.lock` (`mise install --locked`), run
`scripts/dev/dotfiles-bootstrap.sh`, then `mise run deps` (`npm ci`).
`postCreateCommand` also runs `scripts/dev/setup-hooks.sh`.
`postStartCommand` still runs `scripts/dev/install-agent-skills.sh`.
