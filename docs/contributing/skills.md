# Skills index

Skills table moved from `AGENTS.md` §7. First-party skill source is `skills/*/SKILL.md`; third-party skills install into `.agents/skills/` as gitignored output authenticated against reviewed `skills-lock.json` hashes. Container start verifies offline; `npm run skills:install` is the explicit refresh workflow. This page is a routing index only. Ownership tiers (8 core first-party, 14 reusable-optional, 8 design-experiment-optional) are defined in `skills/profiles.json` and summarised in `skills/README.md`; core validation passes with optional profiles uninstalled.

## 7. Skills

First-party agent skills live under `skills/*/SKILL.md` (tracked canonical
source). Harness discovery links to these directories are set up by the
OpenSesame Labs dotfiles, not tracked here. Reviewed third-party skills are
installed into `.agents/skills/` as gitignored output and verified at container
start by `scripts/dev/install-agent-skills.sh`; `.claude/skills/` and `.grok/skills/`
mirrors are relative links to that install. Run
`node scripts/dev/sync-agent-skills.mjs` and its `--check` mode to verify
mirrors; never stage installed trees.

| Skill | Path | Purpose |
|-------|------|---------|
| `opensesame-apis` | `skills/opensesame-apis/SKILL.md` | Install, configure, initialize, and use OpenSesame Host and Identity APIs |
| `opensesame-chrome-extension` | `skills/opensesame-chrome-extension/SKILL.md` | Install, configure, initialize, and use the OpenSesame browser extension |
| `opensesame-clis` | `skills/opensesame-clis/SKILL.md` | Install, configure, initialize, and use OpenSesame host and client CLIs |
| `opensesame-mcps` | `skills/opensesame-mcps/SKILL.md` | Install, configure, initialize, and use OpenSesame MCP servers |
| `install-anti-slop` | `skills/install-anti-slop/SKILL.md` | Install and configure the vendored Oxlint anti-slop plugin |
| `security-review` | `skills/security-review/SKILL.md` | Run repository security gates and targeted Codex Security reviews |
| `visual-evidence` | `skills/visual-evidence/SKILL.md` | Compare two real builds for PR review; persist only approved current-state evidence in feature/project/platform slots |
| `local-debug-session` | `skills/local-debug-session/SKILL.md` | Attach a live HMR debug session when asked to run the app locally; watch real console/page/network errors and patch the hot-reloaded process |
| `impeccable` | User-scope only | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0). It is not project-installed or executed at container start; contributors who trust it may install it in their personal agent profile. |
| `scandinavian-design` | `.agents/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)), authenticated by its `skills-lock.json` hash — the visual-restraint contract behind the Scandinavian retoken |
| `design-taste-frontend` | `.agents/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `design-system` | User-scope only | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)). It is not project-installed or executed at container start; contributors who trust it may install it in their personal agent profile. |
| `gdp-ts` | `.agents/skills/gdp-ts/SKILL.md` (+ `.claude/skills/`) | Third-party ([rauchg/gdp-ts](https://github.com/rauchg/gdp-ts), MIT), installed under `.agents/skills/gdp-ts/` and authenticated by its `skills-lock.json` hash; the workflow for adding or reviewing an authorization check as a compile-time proof (ADR 0178) — brand the id, one `proofs/` module per fact, a `*.mistakes.ts` per proof, no `as` to satisfy a proof |
| `shadcn` | `.agents/skills/shadcn/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([shadcn-ui/ui](https://github.com/shadcn-ui/ui/tree/main/skills/shadcn), MIT), authenticated by its `skills-lock.json` hash; its `design-system.md` workflow turns `DESIGN.md` into a themed shadcn/ui design-system page in a scratch app (never `apps/pages`, which has no `components.json`); the shadcn MCP server (`shadcn@4.21.4 mcp`, stdio) is in every agent's MCP config (`docs/design/tooling.md` § shadcn) |
| `stitch-*` (incl. `stitch-loop`, `stitch-react-native`), `design-md`, `taste-design`, `enhance-prompt`, `site-md`, `shadcn-ui`, `remotion`, `react-vite-dashboard` | `.agents/skills/<skill>/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills), Apache 2.0), linked to the other harnesses and authenticated by reviewed `skills-lock.json` hashes; Google Stitch prototyping over `.stitch/DESIGN.md` and the Stitch MCP server (`docs/design/tooling.md`) |

