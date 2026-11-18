# Skills index

Skills table moved from `AGENTS.md` §7. First-party skill source is `skills/*/SKILL.md`; third-party skills are optional and locally managed. `npm run skills:review` prints guidance for obtaining and reviewing an immutable revision; it does not install anything. This page is a routing index only. Ownership tiers (8 core first-party, 14 reusable-optional, 8 design-experiment-optional) are defined in `skills/profiles.json` and summarised in `skills/README.md`; core validation passes with optional profiles uninstalled.

## 7. Skills

First-party agent skills live under `skills/*/SKILL.md` (tracked canonical
source). Harness discovery links to these directories are set up by the
OpenSesame Labs dotfiles, not tracked here. The third-party paths below are
optional, gitignored local copies, not repository source. Obtain an immutable
revision and review its instructions, references, executables, and dependencies
before configuring it in user scope. `skills-lock.json` is a catalogue and does
not verify an installed copy. `node scripts/dev/sync-agent-skills.mjs --check`
checks local mirror shape, not provenance; never stage installed trees.

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
| `impeccable` | `.agents/skills/impeccable/SKILL.md` | Third-party frontend design skill ([pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache 2.0); an optional, locally configured design detector hook may reference it |
| `scandinavian-design` | `.agents/skills/scandinavian-design/SKILL.md` | Third-party ([ericzakariasson/scandinavian-design](https://github.com/ericzakariasson/scandinavian-design)); visual-restraint guidance for the Scandinavian retoken |
| `design-taste-frontend` | `.agents/skills/design-taste-frontend/SKILL.md` | Third-party anti-slop frontend skill ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT; docs at [tasteskill.dev](https://www.tasteskill.dev/changelog)) |
| `design-system` | `.agents/skills/design-system/SKILL.md` | TypeUI `minimal` registry spec ([typeui.sh](https://www.typeui.sh/design-skills)) |
| `gdp-ts` | `.agents/skills/gdp-ts/SKILL.md` (+ `.claude/skills/`) | Third-party ([rauchg/gdp-ts](https://github.com/rauchg/gdp-ts), MIT); guidance for authorization checks as compile-time proofs (ADR 0178) |
| `shadcn` | `.agents/skills/shadcn/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([shadcn-ui/ui](https://github.com/shadcn-ui/ui/tree/main/skills/shadcn), MIT); its `design-system.md` workflow turns `DESIGN.md` into a themed shadcn/ui design-system page in a scratch app (never `apps/pages`, which has no `components.json`); see `docs/design/tooling.md` § shadcn |
| `stitch-*` (incl. `stitch-loop`, `stitch-react-native`), `design-md`, `taste-design`, `enhance-prompt`, `site-md`, `shadcn-ui`, `remotion`, `react-vite-dashboard` | `.agents/skills/<skill>/SKILL.md` (+ `.claude/skills/`, `.grok/skills/`) | Third-party ([google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills), Apache 2.0); Google Stitch prototyping over `.stitch/DESIGN.md` and the Stitch MCP server (`docs/design/tooling.md`) |

