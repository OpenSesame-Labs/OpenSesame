#!/usr/bin/env bash
# Retired floating installer: print migration guidance without touching files.
set -eu

mode="${1:-}"
if (( $# > 1 )) || [[ "$mode" != "" && "$mode" != "--instructions" ]]; then
  printf '%s\n' 'Usage: npm run skills:review' >&2
  exit 2
fi

printf '%s\n' \
  'The automatic third-party skills installer is retired.' \
  'No skills were installed or updated; no files or settings were changed.' \
  'Previously installed copies may still be discoverable; disable unreviewed copies.' \
  '' \
  'To use an optional skill:' \
  '  1. Obtain an immutable revision through your approved source process.' \
  '  2. Review its instructions, references, executable files, and dependencies.' \
  '  3. Configure your harness to use only that reviewed copy in user scope.' \
  '' \
  'skills-lock.json is a catalogue, not verification of installed content.' \
  'First-party skills remain in skills/; see docs/contributing/agent-setup.md.'

# Preserve the old command as an explicit failure: it cannot claim that an
# installation succeeded. The new review command succeeds after showing help.
if [[ "$mode" != "--instructions" ]]; then exit 1; fi
