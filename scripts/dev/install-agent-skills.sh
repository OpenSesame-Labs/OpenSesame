#!/usr/bin/env bash
# Verify third-party agent skills, or explicitly refresh them with --refresh.
#
# These skills are install output, not source: .gitignore covers every
# harness root except the repo-built adapters whitelisted there, and the
# third-party trees were removed from source control. skills-lock.json is the
# reviewed content-integrity catalogue. Container startup never fetches or
# updates executable instructions. A maintainer may pass --refresh to update
# installed copies and the catalogue together for review. The installer CLI is
# version-pinned in mise.toml. Tiers live in skills/profiles.json. First-party
# skills in skills/ are tracked source and need no install; core
# validation passes without any of this.
#
# Runs in verification-only mode on every devcontainer start and refreshes only
# via `npm run skills:install`. Safe to re-run; a lock
# file (override: OPENSESAME_SKILLS_LOCK_FILE) serializes concurrent
# runs. Hash mismatches and uncatalogued third-party skills are moved out of
# discovery roots; the outcome is recorded in
# .agents/.skills-currency.json instead of failing container start.
set -uo pipefail

# Pinned installer tool version. `mise install` puts it on PATH; npx below uses
# the same pin only during an explicit refresh.
SKILLS_CLI="skills@1.7.4"

REFRESH="false"
if [ "${1:-}" = "--refresh" ]; then
  REFRESH="true"
elif [ "$#" -ne 0 ]; then
  echo "usage: $0 [--refresh]" >&2
  exit 2
fi

cd "$(dirname "$0")/../.." || exit 1
warn() { echo "install-agent-skills: WARN: $*" >&2; }
STATUS="ok"
degrade() { STATUS="degraded"; warn "$*"; }

# Serialize concurrent runs (postStart + manual) when flock is available.
mkdir -p .agents
LOCK_FILE="${OPENSESAME_SKILLS_LOCK_FILE:-.agents/.skills-install.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -w 120 9; then
    warn "another skills install is running; skipping this run"
    exit 0
  fi
fi

# Snapshot which tracked adapter files are already dirty, so the
# restore at the end only touches installer side effects, never local work.
TRACKED=".codex/hooks.json .claude/settings.json"
DIRTY_BEFORE=$(git status --porcelain -- $TRACKED 2>/dev/null | cut -c4- | sort || true)

# 1. During an explicit refresh, install missing catalogue skills.
#    (lock key stitch::x installs as stitch-x/). Explicit agents only:
#    '*' also writes Universal (./skills/) and OpenClaw (./agent/) roots
#    this repo does not use. Codex, Copilot, OpenCode, and Gemini
#    discover .agents/skills natively; Claude Code and Grok need mirrors.
missing=""
if [ "$REFRESH" = "true" ] && ! missing=$(node -e "
  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync('skills-lock.json', 'utf8'));
  for (const [name, meta] of Object.entries(lock.skills)) {
    const dir = name.replace('stitch::', 'stitch-');
    if (!fs.existsSync('.agents/skills/' + dir + '/SKILL.md'))
      console.log(name + '\t' + meta.source);
  }
"); then
  degrade "could not read skills-lock.json; skipping catalogue install"
  missing=""
fi
if [ "$REFRESH" = "true" ] && ! command -v skills >/dev/null 2>&1; then
  echo "install-agent-skills: HINT: mise install npm:skills installs the pinned CLI; using npx ${SKILLS_CLI}" >&2
fi
if [ -n "$missing" ]; then
  while IFS="$(printf '\t')" read -r name source; do
    echo "install-agent-skills: adding $name from $source (latest)"
    timeout --kill-after=15 300 npx -y "$SKILLS_CLI" add "$source" -s "$name" -a claude-code -a grok --full-depth -y </dev/null \
      || degrade "could not install optional skill $name"
  done <<< "$missing"
fi

# 2. Refresh only when a maintainer explicitly requested reviewed lock changes.
if [ "$REFRESH" = "true" ]; then
  timeout --kill-after=15 600 npx -y "$SKILLS_CLI" update -y </dev/null \
    || degrade "skills update failed; keeping verified installed versions"
  # The installer owns computedHash, whose legacy path/content concatenation
  # is ambiguous. Keep it for installer compatibility and record our reviewed,
  # framed whole-tree digest in a dedicated versioned field.
  node --input-type=module -e "
    import fs from 'node:fs';
    import { skillTreeHashV2 } from './scripts/dev/verify-agent-skills.mjs';
    const lock = JSON.parse(fs.readFileSync('skills-lock.json', 'utf8'));
    for (const [name, entry] of Object.entries(lock.skills)) {
      const dir = '.agents/skills/' + name.replace('stitch::', 'stitch-');
      if (!fs.existsSync(dir + '/SKILL.md')) throw new Error('missing refreshed skill ' + name);
      entry.treeHashV2 = skillTreeHashV2(dir);
    }
    lock.integrity = { algorithm: 'opensesame-skill-tree-v2' };
    fs.writeFileSync('skills-lock.json', JSON.stringify(lock, null, 2) + '\n');
  " || degrade "could not record framed catalogue tree hashes"
fi

# 3. Remove hook registrations installers wrote into ignored roots
#    (older host installs, other tools), preserving unrelated hooks: only
#    the impeccable entries are stripped from shared manifests, and only
#    single-purpose impeccable.json manifests are deleted. Tracked files
#    are never touched.
for f in .grok/hooks/impeccable.json .github/hooks/impeccable.json; do
  if [ -f "$f" ] && grep -qi impeccable "$f" && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    rm -f "$f"
    echo "install-agent-skills: removed installer-written hook manifest $f"
  fi
done
for f in .cursor/hooks.json .claude/settings.local.json; do
  if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    HOOK_FILE="$f" node -e "
      const fs = require('fs');
      const path = process.env.HOOK_FILE;
      try {
        const data = JSON.parse(fs.readFileSync(path, 'utf8'));
        let changed = false;
        for (const [event, groups] of Object.entries(data.hooks ?? {})) {
          data.hooks[event] = (groups ?? [])
            .map((g) => {
              if (!Array.isArray(g.hooks)) {
                return /impeccable/u.test(g.command ?? '') ? (changed = true, null) : g;
              }
              const kept = g.hooks.filter((h) => !/impeccable/u.test(h.command ?? ''));
              if (kept.length !== g.hooks.length) changed = true;
              return kept.length ? { ...g, hooks: kept } : null;
            })
            .filter(Boolean);
          if (!data.hooks[event].length) delete data.hooks[event];
        }
        if (changed) {
          if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
          fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
          console.log('install-agent-skills: stripped impeccable hooks from ' + path);
        }
      } catch { /* unparseable user settings: leave untouched */ }
    " || true
  fi
done

# 4. Reject unreviewed executable instructions before mirrors are exposed.
if ! node scripts/dev/verify-agent-skills.mjs --quarantine; then
  degrade "unverified third-party skills were quarantined"
fi

# 5. Installers materialize real copies in harness mirrors; collapse them
#    to links (this also removes stale mirrors of uninstalled optional
#    skills). Then restore tracked adapters that installers rewrite —
#    but only files that were clean before this run; pre-existing local
#    edits are left alone. An explicit refresh leaves skills-lock.json changed
#    for review; ordinary startup never writes it.
node scripts/dev/sync-agent-skills.mjs || degrade "skill mirror sync reported problems"
for f in $TRACKED; do
  if printf '%s\n' "$DIRTY_BEFORE" | grep -qx "$f"; then
    warn "leaving locally modified $f untouched (installer changes not reverted)"
  else
    git checkout -- "$f" 2>/dev/null || true
  fi
done

# 6. Record currency durably, then gate. A failed check degrades the run
#    (recorded + warned) instead of failing container start; CI gates the
#    fresh tracked tree separately.
if ! node scripts/dev/sync-agent-skills.mjs --check; then
  degrade "sync --check failed after install (see above)"
fi
node -e "
  const fs = require('fs');
  const root = '.agents/skills';
  const installed = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => fs.existsSync(root + '/' + n + '/SKILL.md')).sort()
    : [];
  fs.writeFileSync('.agents/.skills-currency.json', JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    status: '$STATUS',
    method: '$REFRESH' === 'true' ? 'explicit reviewed-catalog refresh' : 'offline integrity verification',
    installed,
  }, null, 2) + '\n');
" || warn "could not write .agents/.skills-currency.json"
echo "install-agent-skills: done (status: $STATUS)"
