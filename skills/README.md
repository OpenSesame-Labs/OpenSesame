# skills/

Agent skills — self-contained instructions a coding agent loads for one kind
of task. Each directory holds a `SKILL.md` with a `description` the agent
matches against. This repo tracks no `.agents/` or other harness dot
entries: your dotfiles link each of these into the discovery path your tool
reads. Third-party skills are optional local copies, not repository source.
`npm run skills:review` prints guidance for obtaining and reviewing an immutable
revision in user scope. It does not fetch, execute, install, or update skills;
the retired `npm run skills:install` fails after printing the guidance.
[`skills-lock.json`](../skills-lock.json) is a catalogue, not verification of
installed content. Harness roots are gitignored outright and installed trees
are never staged. `node scripts/dev/sync-agent-skills.mjs --check` checks local
mirror shape, not provenance. Previously installed copies may still be
discoverable; disable any unreviewed copy in your harness until its origin
and contents are reviewed.

## Ownership tiers

The machine-readable catalogue is [`profiles.json`](profiles.json). Edit it
together with this file; `sync-agent-skills.mjs --check` fails on a `skills/`
or `.agents/skills/` entry that no profile lists, a core skill whose existing
`.agents/skills/` alias points elsewhere, or a skill listed in two profiles.

- **First-party default (`core`, required).** Authored here, canonical in
  `skills/`. Core validation requires every one of them; local
  `.agents/skills/` aliases are optional.
- **Reusable optional (`reusable-optional`).** Third-party and generic, but
  part of a workflow this repo uses (the applicable Stitch toolchain,
  `impeccable`, `gdp-ts`). Canonical in `.agents/skills/`; a separate install
  may live in `.agents/skills-optional/` and the sync checker resolves either.
- **Design-experiment optional (`design-experiment-optional`).** Third-party
  aesthetics and stack catalogues kept for experiments. They are not defaults
  for work in `apps/pages`.

Optional skills may be absent: core `--check` passes with none of them
installed. A harness mirror (`.claude/skills/`, `.grok/skills/`) left behind
for an uninstalled optional skill is skipped by the checker; removing it is
the harness owner's job. An unlisted or core name without a canonical install
still fails.

Provenance: 20 of the 22 third-party skills are catalogued in
[`skills-lock.json`](../skills-lock.json). The exceptions are `design-system`
(which also declares frontmatter `name: minimal`) and `impeccable`. The tiers
say what is a default; a fresh clone has only the core profile. The catalogue
does not establish an installed copy's source or integrity. Obtain an immutable
revision through an approved source process and review its instructions,
references, executables, and dependencies before using it. Anything a build
or gate depends on must be core.

## Using OpenSesame

| Skill | For |
|---|---|
| [`opensesame-apis`](opensesame-apis/SKILL.md) | Configuring and calling the Host and Identity APIs. |
| [`opensesame-clis`](opensesame-clis/SKILL.md) | The host CLI (`opensesame`) and client CLI (`opensesame-id`). |
| [`opensesame-mcps`](opensesame-mcps/SKILL.md) | Installing and using the MCP servers. |
| [`opensesame-chrome-extension`](opensesame-chrome-extension/SKILL.md) | Installing and using the browser extension. |

## Developing OpenSesame

| Skill | For |
|---|---|
| [`local-debug-session`](local-debug-session/SKILL.md) | "Run it locally": an attached Vite HMR session with the browser console watched, never a static preview. |
| [`visual-evidence`](visual-evidence/SKILL.md) | Before/after screenshots from two real builds for any user-visible change. |
| [`security-review`](security-review/SKILL.md) | The deterministic security gates and budgeted Codex Security scans. |
| [`install-anti-slop`](install-anti-slop/SKILL.md) | Installing the anti-slop Oxlint plugin into another repository; its `assets/` mirror [`tools/oxlint/anti-slop`](../tools/oxlint/anti-slop) (`npm run test:anti-slop` checks they match), `install.mjs --no-tests` leaves the test suites out, and the asset's `MANIFEST.sha256` and `verify.mjs` let a consuming repository check its copy offline (`npm run anti-slop:manifest` regenerates the manifest). |

## Reusable optional (third-party, in `.agents/skills/`)

| Skill | For |
|---|---|
| `design-md` | Generating a `DESIGN.md` from a Stitch project. |
| `enhance-prompt` | Polishing a prompt before sending it to Stitch. |
| `gdp-ts` | Compile-time authorization proofs in TypeScript (ADR 0178 workflow). |
| `impeccable` | Generic frontend design, critique, and audit. Also wired into the pre-commit hook and Codex hook; removing it needs those owners. |
| `site-md` | Maintaining the `.stitch/SITE.md` site constitution. |
| `stitch-code-to-design` | Sending existing code to Stitch as a design. |
| `stitch-extract-design-md` | Extracting a `DESIGN.md` from a Stitch screen. |
| `stitch-extract-static-html` | Extracting static HTML from a Stitch screen. |
| `stitch-generate-design` | Generating a Stitch design from a prompt. |
| `stitch-loop` | The autonomous Stitch build loop. |
| `stitch-manage-design-system` | Managing a Stitch design system. |
| `stitch-react-components` | Converting a Stitch screen to Vite/React components. Nothing moves from Stitch into `apps/pages` directly; see `docs/design/tooling.md`. |
| `stitch-upload-to-stitch` | Uploading an image or file to a Stitch project. |
| `taste-design` | Anti-generic guidance for Stitch `DESIGN.md` files. |

The `stitch-*` directories declare colon frontmatter names (`stitch::*`);
that is upstream's naming and is kept as-is.

## Design-experiment optional (third-party, in `.agents/skills/`)

Invoke these by name for an experiment; do not treat their tokens or stacks
as the contract for `apps/pages` (`DESIGN.md` wins on any conflict).

| Skill | Note |
|---|---|
| `design-system` | Generic TypeUI design-system tokens. Declares frontmatter `name: minimal`. Not in `skills-lock.json`. |
| `design-taste-frontend` | Landing pages, portfolios, and redesigns. Its own body excludes dashboards and multi-step product UI. |
| `react-vite-dashboard` | Unused stack: TanStack Query + Web3 dashboards. Not used by this app. |
| `remotion` | Unused stack: Remotion walkthrough videos. Not used by this app. |
| `scandinavian-design` | Black-and-white restraint, invoke-only (`disable-model-invocation`). |
| `shadcn` | Scratch-only: restyles shadcn/ui from `DESIGN.md` outside the repo to test its completeness, never in `apps/pages`. |
| `shadcn-ui` | Unused stack: the Stitch-build shadcn variant (Radix/Tailwind). Not used by this app. Distinct from `shadcn`. |
| `stitch-react-native` | Unused stack: React Native conversion. Not used by this app. |

A new first-party skill gets a directory here, a row in the
[skills index](../docs/contributing/skills.md), an entry under `core` in
`profiles.json`, and a whitelist line in the `skills/` section of `.gitignore`.
Nothing is added under `.agents/` (harness roots are ignored outright). A new third-party skill gets an entry
in one optional profile in `profiles.json` (and a `skills-lock.json` entry when
its updater provides one).
