# Agent setup (user scope)

This repository tracks **no AI-harness dotfiles or dot folders**. Hooks,
rules, MCP definitions, workflows, permission auto-allows, model and
subscription routing, plugin enablement, API keys and skill discovery links
all live in the OpenSesame Labs dotfiles repo and are applied per user. Canonical
product/agent rules remain `AGENTS.md`.

## What is not tracked here

`.agents/`, `.claude/`, `.codex/`, `.cursor/`, `.grok/`, `.githooks-grok/`,
`.impeccable/` (at any depth), `.stitch/` and `.mcp.json` are gitignored
outright, with no whitelist. Anything an installer or harness writes there is
local output and can never be staged. `opencode.json` and
`.github/copilot-instructions.md` are not dot folders and are not covered by
this rule.

What stays tracked is the product's own source: first-party skills in
`skills/` (canonical `SKILL.md` sources and the `skills/profiles.json`
catalogue), `AGENTS.md`, and the repo tooling under `scripts/`.
`node scripts/dev/sync-agent-skills.mjs --check` validates `skills/` and any
`.agents/skills/` links that exist locally; it does not require them.

Your dotfiles are responsible for linking each `skills/<name>` into the
discovery paths your harness reads (for example `~/.agents/skills`).

## Personal setup (user scope)

### Dotfiles with chezmoi

Keep personal harness config in your own dotfiles repo, applied with
[chezmoi](https://www.chezmoi.io/) — never in this repo, and never mounted
into a devcontainer by repo lifecycle commands.

```bash
chezmoi init --apply <your-dotfiles-repo>
chezmoi update        # pull + apply
chezmoi diff          # preview before applying
```

Devcontainers/Codespaces: use the editor's native dotfiles settings
(`dotfiles.repository`, `dotfiles.installCommand`, `dotfiles.targetPath`)
in your **user** settings. Git identity/signing comes from the editor's
native `.gitconfig` copy and SSH/GPG agent forwarding — never bind-mount
`~/.ssh`, `~/.gnupg`, or `~/.gitconfig` from repo config.

### Skills into `~/.agents/skills`

Install personal/third-party skills once at user scope:

```bash
mkdir -p ~/.agents/skills
# install or clone each skill as ~/.agents/skills/<name>/SKILL.md
```

For Claude, use a link adapter instead of copying (copies drift):

```bash
mkdir -p ~/.claude/skills
ln -s ~/.agents/skills/<name> ~/.claude/skills/<name>   # per skill
```

Project skills work differently in-repo: first-party source is `skills/`
(tracked, aliased from `.agents/skills/`); third-party skills install into
`.agents/skills/` with `.claude/skills/` and `.grok/skills/` mirrors, all
gitignored and refreshed to latest at container start by
`scripts/dev/install-agent-skills.sh`. Harness-specific variants an
installer writes (e.g. impeccable's Claude copy) are install output too;
`node scripts/dev/sync-agent-skills.mjs` collapses duplicate mirrors to
links and `--check` verifies them.

### Claude permissions (auto-allow)

Permission auto-allows are per-user trust decisions. Put them in the
gitignored `.claude/settings.local.json`, not tracked settings. The
product gate commands most contributors allow:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run typecheck)",
      "Bash(npm run lint)",
      "Bash(npm run lint:all)",
      "Bash(npm test)",
      "Bash(npm run test:all)",
      "Bash(npm run test:integration)",
      "Bash(npx tsc --noEmit)"
    ]
  }
}
```

### Stitch plugins and `STITCH_API_KEY`

Stitch needs your own key: `export STITCH_API_KEY=...` in your shell/dotfiles
(secret store preferred). MCP definitions that name the env var live in your
dotfiles, not in this repo.

The `google-labs-code/stitch-skills` marketplace plugins
(`stitch-design`, `stitch-build`, `stitch-utilities`) are **not**
auto-enabled — the same skills install (latest,
unpinned) into `.agents/skills/stitch-*` per the `skills-lock.json`
catalogue at container start. To use the
marketplace copies instead, enable them in your user Claude settings
(`extraKnownMarketplaces` + `enabledPlugins` for
`google-labs-code/stitch-skills`).

### Model routing (operator profiles)

Tier routing, subscription auth, and quota fallbacks are operator setup.
This section is the chain's home; the harness rule adapters in the dotfiles
repo point here.

1. **Tier 1 — Grok Build CLI.** Delegate coding through
   `scripts/dev/grok-headless.sh` (subscription auth from
   `~/.grok/auth.json`, installed by
   `scripts/dev/grok-install-subscription-auth.sh`; never `XAI_API_KEY` —
   an API-key 403 is misconfiguration, not tier exhaustion). Resolve the
   model with `scripts/dev/grok-resolve-model.sh` and run
   `scripts/dev/agent-coding-preflight.sh` before batch work.
2. **Tier 2 — Kimi Code CLI.** Only when Grok itself reports a weekly
   limit/quota. Auth via `kimi login` (or `KIMI_MODEL_API_KEY`); runbook
   `kimi-code.md` in the dotfiles repo.
3. **Tier 3 — Cursor.** When Kimi is also exhausted: Grok model for
   security/red-team work, Composer/auto otherwise.

Record the tier used and why in the PR Provenance section. Details:
`kimi-code.md` (dotfiles repo) and `docs/operators/kimi-code-cloud.md` for runbooks,
and `scripts/dev/{grok,kimi,agent-coding}-preflight.sh` before batch work.
Never commit auth files, API keys, or `auth.preferred_method = "api_key"`
for device-login setups (see the Grok config in the dotfiles repo).

## Profiles

- **Default (clone):** clone and open in any harness. No harness config is
  tracked; apply the OpenSesame Labs dotfiles for hooks, rules and MCP
  definitions. Nothing personal is assumed by the repo.
- **Personal (user):** chezmoi dotfiles + `~/.agents/skills` + Claude link
  adapter + `settings.local.json` + your `STITCH_API_KEY`.
- **Devcontainer:** `.devcontainer/devcontainer.json` — pinned Rust image,
  Node 24 feature at build time, user-writable npm
  (`--install-directory "$HOME/.local/bin"`, `COREPACK_HOME` under
  `/home/vscode`), frozen-lockfile install in `updateContentCommand`,
  hooks in `postCreateCommand`; only the npm cache is a named
  (per-workspace) volume — executable caches (cargo target, npm)
  stay container-local so no cache crosses checkouts.
  `postStartCommand` runs `scripts/dev/install-agent-skills.sh` only
  (latest third-party skills into gitignored roots; warns and continues
  offline). No other `postAttach` work, no host paths, no dotfiles.
  In-container planes use `127.0.0.1` defaults (`scripts/dev/local-env.sh`).
- **Host-agent (opt-in, not tracked):** if you run host planes, add your
  own devcontainer override with
  `runArgs: ["--add-host=host.docker.internal:host-gateway"]` and
  `OPENSESAME_HOST_API`/`OPENSESAME_ISSUER`/`OPENSESAME_AGENT_URL`
  pointing at `host.docker.internal:8787/8788/18790`. Do not commit it:
  the host-agent socket contract is not wired in-repo.

## Update / rollback

- Dotfiles: `chezmoi update`; rollback with `chezmoi apply` at an older
  dotfiles revision (`git -C "$(chezmoi source-path)" checkout <rev>`).
- Personal skills: update in `~/.agents/skills` only; links follow.
  Rollback = restore that directory; no repo change needed.
- Project skills: third-party content floats to latest at every
  container start (`skills-lock.json` is the catalogue, not a pin).
  Catalogue changes are reviewed commits; check
  `.agents/.skills-currency.json` for what the last start installed.
- Harness config changes: make them in the dotfiles repo, not here. Rollback
  is a revert there — this repo carries none of it.
- Devcontainer: rebuild (`Dev Containers: Rebuild Container`) after image
  or feature changes; the per-workspace npm-store volume survives
  rebuilds, executable caches do not. Delete the `opensesame-*` volumes
  to fully reset caches.

## Acceptance checklist

- [ ] No harness dotfiles are tracked:
      `git ls-files | grep -E '(^|/)\.(agents|claude|codex|cursor|grok|impeccable|stitch|githooks-grok)(/|$)|(^|/)\.mcp\.json$'` prints nothing
- [ ] `node scripts/dev/sync-agent-skills.mjs --check` exits 0; no broken
      symlinks under `.claude/skills`, `.grok/skills`, `.agents/skills`
      (when present locally)
- [ ] Devcontainer: `postStart` runs only the skills install, no `postAttach`,
      no `host.docker.internal`,
      no `${localEnv:HOME}` mount; `id` in lifecycle is `vscode`;
      `node -v`, `npm -v`, `cargo -V` succeed after create
- [ ] Personal layer works from a clean clone: chezmoi apply →
      `~/.agents/skills` → Claude links → `settings.local.json` →
      optional Stitch key/plugins and tier routing
