#!/usr/bin/env bash
# Guest formal suite: AUTH-C1, GUEST-V1, CONN-S1, LOCAL-D1 and EXT-O1.
#   verify.sh                      Lean proofs and axiom audit, every Lean vector
#                                  replayed against the real code, the test
#                                  inventory, and the reviewed-source blobs.
#   verify.sh --negative-controls  each guard mutation (applied in memory as the
#                                  module loads; no file changes) must fail a
#                                  correspondence assertion.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
suite="$root/spec/formal/guest"
mode="${1:-gate}"
if [[ -n "${OPENSESAME_GUEST_MUTANT:-}" ]]; then
  echo "guest-formal: a mutant cannot be used as the verified implementation" >&2
  exit 1
fi
if [[ "$mode" != "gate" && "$mode" != "--negative-controls" ]]; then
  echo "usage: $0 [--negative-controls]" >&2
  exit 2
fi
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "guest-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ ! -x "$root/node_modules/.bin/vitest" ]]; then
  echo "guest-formal: install the repository's Node dependencies first" >&2
  exit 1
fi
temporary="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-guest-formal.XXXXXXXX")"
trap 'rm -rf "$temporary"' EXIT

# Reviewed implementation blobs (README "Reviewed sources"). A changed source
# fails here until its model correspondence is reviewed and the blob updated.
drift=0
reviewed=0
while IFS= read -r line; do
  [[ "$line" =~ ^-\ \`([^\`]+)\`:\ \`([0-9a-f]{40})\`$ ]] || continue
  reviewed=$((reviewed + 1))
  if [[ "$(git hash-object --no-filters "$root/${BASH_REMATCH[1]}")" != "${BASH_REMATCH[2]}" ]]; then
    echo "guest-formal: source drift in ${BASH_REMATCH[1]}; review the model and update README.md" >&2
    drift=1
  fi
done < "$suite/README.md"
if [[ "$reviewed" -ne 18 || "$drift" -ne 0 ]]; then
  echo "guest-formal: reviewed sources do not match ($reviewed listed, 18 expected)" >&2
  exit 1
fi

vectors="$temporary/vectors.tsv"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$suite/GuestContract.lean" > "$vectors"

# The Vitest config is generated, with app-core's aliases and setup. Only a
# negative control names an edit: one exact, unique replacement in one module.
cat > "$temporary/vitest.config.mjs" <<'CONFIG'
import { readFileSync } from "node:fs";
const root = process.env.OPENSESAME_GUEST_ROOT;
const mutant = process.env.OPENSESAME_GUEST_MUTANT;
const edit = mutant ? JSON.parse(readFileSync(mutant, "utf8")) : null;
const osDomain = (path) => `${root}/packages/os-domain/src/${path}`;
const mutation = {
  name: "guest-formal-mutant",
  enforce: "pre",
  transform(code, id) {
    if (id.split("?")[0] !== `${root}/${edit.file}`) return null;
    if (code.split(edit.before).length !== 2)
      throw new Error(`mutation point is not unique in ${edit.file}`);
    return code.replace(edit.before, () => edit.after);
  },
};
export default {
  root,
  define: { "process.env.NODE_DEBUG_NATIVE": "false" },
  plugins: edit ? [mutation] : [],
  resolve: {
    alias: {
      "@opensesame/os-domain/authority-templates": osDomain("authority-templates/index.ts"),
      "@opensesame/os-domain/wallet": osDomain("wallet/index.ts"),
      "@opensesame/os-domain": osDomain("browser.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "spec/formal/guest/guest-conformance.test.ts",
      "spec/formal/guest/custody-conformance.test.ts",
    ],
    setupFiles: [`${root}/packages/app-core/src/test-setup.ts`],
    testTimeout: 300000,
    retry: 0,
  },
};
CONFIG
run_vitest() {
  OPENSESAME_GUEST_ROOT="$root" OPENSESAME_GUEST_FORMAL_VECTORS="$vectors" \
    "$root/node_modules/.bin/vitest" run --config "$temporary/vitest.config.mjs" --root "$root" "$@"
}

if [[ "$mode" == "--negative-controls" ]]; then
  caught=0
  while IFS= read -r control; do
    printf '%s' "$control" > "$temporary/mutant.json"
    name="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name' "$temporary/mutant.json")"
    filter="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).test' "$temporary/mutant.json")"
    if OPENSESAME_GUEST_MUTANT="$temporary/mutant.json" run_vitest -t "$filter" > "$temporary/out" 2>&1; then
      echo "guest-formal: control $name was not detected" >&2
      exit 1
    fi
    if ! grep -q "AssertionError" "$temporary/out" || grep -q "mutation point is not unique" "$temporary/out"; then
      tail -20 "$temporary/out" >&2
      echo "guest-formal: control $name failed without a correspondence assertion" >&2
      exit 1
    fi
    caught=$((caught + 1))
    echo "$name: caught by correspondence assertion"
  done <<'CONTROLS'
{"name": "admission-host", "file": "packages/app-core/src/lib/guest-auth.ts", "before": "    guestAuthDependencies.hasHostSession() ||", "after": "    false ||", "test": "admission"}
{"name": "admission-in-lock", "file": "packages/app-core/src/lib/guest-auth.ts", "before": "? () => assertNoKnownRemoteSession(expectedPrincipalId)", "after": "? () => {}", "test": "admission"}
{"name": "admission-after-mint", "file": "packages/app-core/src/lib/guest-auth.ts", "before": "  assertNoKnownRemoteSession(session.principalId);\n", "after": "", "test": "admission"}
{"name": "fresh-cookie-before", "file": "packages/app-core/src/lib/identity.ts", "before": "  requireNoSessionForGuest(inspected, revision, base);\n", "after": "", "test": "fresh mint"}
{"name": "fresh-unknown-as-absent", "file": "packages/app-core/src/lib/identity.ts", "before": "if (inspected.kind === \"absent\" && sessionRevision === revision) return;", "after": "if (inspected.kind !== \"present\" && sessionRevision === revision) return;", "test": "fresh mint"}
{"name": "fresh-signout-unseen-at-mint", "file": "packages/app-core/src/lib/identity.ts", "before": "  syncSharedSignOut();\n  if (sessionEpoch !== epoch) {", "after": "  if (sessionEpoch !== epoch) {", "test": "fresh mint"}
{"name": "pairing-response-refusal", "file": "packages/app-core/src/lib/browser-pairing.ts", "before": "  if (!isLocalOnlyGuest()) return;", "after": "  return;", "test": "pairing"}
{"name": "pairing-after-proof", "file": "packages/app-core/src/lib/browser-pairing.ts", "before": "  assertEligible();\n  if (init.body", "after": "  if (init.body", "test": "pairing"}
{"name": "pairing-grant-report", "file": "packages/app-core/src/lib/browser-pairing.ts", "before": "  if (isLocalOnlyGuest()) return null;\n", "after": "", "test": "pairing"}
{"name": "epoch-unknown-capture", "file": "packages/app-core/src/lib/identity-shared-signout.ts", "before": "if (captured === null || readAuthGeneration() !== captured)", "after": "if (readAuthGeneration() !== captured)", "test": "epoch"}
{"name": "epoch-unreadable-as-zero", "file": "packages/app-core/src/lib/auth-generation.ts", "before": "    return null;", "after": "    return 0;", "test": "epoch"}
{"name": "transient-reuse", "file": "packages/app-core/src/lib/vfs-transient-guest.ts", "before": "if (!isIsolatedGuestVaultId(tomb) || tombs.has(tomb))", "after": "if (!isIsolatedGuestVaultId(tomb))", "test": "transient"}
{"name": "transient-foreign-freeze", "file": "packages/app-core/src/lib/vfs-transient-guest.ts", "before": "if (!store || store.owner !== owner || store.retired || store.frozen)", "after": "if (!store || store.retired || store.frozen)", "test": "transient"}
{"name": "transient-block-ignored", "file": "packages/app-core/src/lib/vfs-transient-guest.ts", "before": "store.blocked = blocked;", "after": "store.blocked = false;", "test": "transient"}
{"name": "open-keeps-transient", "file": "packages/app-core/src/lib/vault/store-guest-material.ts", "before": "    if (transient) discardUnpublishedTransientGuest(scope.tomb, transient);\n", "after": "", "test": "opening"}
{"name": "publish-scratch", "file": "packages/app-core/src/lib/vault/store-header-publication.ts", "before": "    if (tomb === DECOY_SCRATCH_TOMB)", "after": "    if (false)", "test": "publication"}
{"name": "promotion-header-early", "file": "packages/app-core/src/lib/vault/guest-vault-promotion.ts", "before": "        if (key !== headerKey) await kvSetDurable(key, value, check);", "after": "        await kvSetDurable(key, value, check);", "test": "promotion"}
{"name": "deletion-unlink-first", "file": "packages/app-core/src/lib/vfs-guest-deletion.ts", "before": "  dirty.add(tomb);\n  const blob = await vfsSeams.seal(", "after": "  dirty.add(tomb);\n  await io.deleteRawGuarded(keyFor(tomb, path), check);\n  const blob = await vfsSeams.seal(", "test": "deletion"}
{"name": "directory-lock-keeps", "file": "packages/app-core/src/lib/connector-directory.ts", "before": "onVaultLock(clearPendingConnectorDirectory);", "after": "", "test": "directory staging"}
{"name": "directory-late-seal", "file": "packages/app-core/src/lib/connector-directory.ts", "before": "    await writeConnectorDirectory(tomb, record, generationCheck(generation));", "after": "    await writeConnectorDirectory(tomb, record);", "test": "directory staging"}
{"name": "vercel-lock-keeps", "file": "packages/app-core/src/lib/vercel-connect-session.ts", "before": "onVaultLock(() => {\n  clearPendingVercelConnectAuth();", "after": "onVaultLock(() => {", "test": "vercel staging"}
{"name": "vercel-late-restore", "file": "packages/app-core/src/lib/vercel-connect-session.ts", "before": "    if (generation === pendingGeneration && !signal?.aborted && !pending)", "after": "    if (!pending)", "test": "vercel staging"}
{"name": "local-error-as-empty", "file": "packages/app-core/src/lib/local-directory.ts", "before": "    if (error instanceof VfsError && error.code === \"not-found\") {", "after": "    if (error instanceof Error) {", "test": "local directory"}
{"name": "page-fill-origin", "file": "apps/browser-extension/runner/page-fns.ts", "before": "  if (win.location.origin !== expectedOrigin) return \"off_origin\";\n  let element: Element | null;\n  try {\n    element = document.querySelector(selector);\n  } catch {\n    return \"invalid\";\n  }\n  if (!element) return \"no_such_field\";", "after": "  let element: Element | null;\n  try {\n    element = document.querySelector(selector);\n  } catch {\n    return \"invalid\";\n  }\n  if (!element) return \"no_such_field\";", "test": "page functions"}
{"name": "page-fill-after-focus", "file": "apps/browser-extension/runner/page-fns.ts", "before": "  if (leftAuthorizedPage()) {", "after": "  if (false) {", "test": "page functions"}
{"name": "page-layout-window", "file": "apps/browser-extension/runner/page-fns.ts", "before": "  if (!win || win.location.origin !== expectedOrigin)\n    throw new Error(\"off_origin\");\n  const root", "after": "  if (win && win.location.origin !== expectedOrigin)\n    throw new Error(\"off_origin\");\n  const root", "test": "page functions"}
CONTROLS
  echo "guest-formal: all $caught negative controls detected"
  exit 0
fi

report="$temporary/report.json"
run_vitest --maxWorkers=2 --reporter=default --reporter=json --outputFile.json="$report"
node - "$report" <<'CHECK'
const report = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const expected = [
  "admission: continueAsGuest agrees with `admit` on every case",
  "fresh mint: connectFreshProvisional agrees with `connectFresh`",
  "pairing: pairedHostFetch sends a grant only after clear boundaries",
  "epoch: assertSignOutEpoch agrees with `epochHolds`",
  "transient guest: the store agrees with `tstep` on every three-step trace",
  "guest opening agrees with `guestScope` and `prepareOpen`",
  "header publication agrees with `publish`",
  "promotion agrees with `promote`: the header is the last durable write",
  "deletion agrees with `deletionPlan`: journal, unlink, index, idle",
  "directory staging agrees with `dstep` on every enabled trace",
  "vercel staging agrees with `dstep` on every enabled trace",
  "local directory reads agree with `readDir`; a refused read is never rewritten",
  "page functions agree with `pageReads`/`pageActs` (EXT-O1)",
].sort();
const passed = report.testResults
  .flatMap((file) => file.assertionResults)
  .filter((test) => test.status === "passed")
  .map((test) => test.title)
  .sort();
if (
  report.success !== true ||
  report.numTotalTests !== expected.length ||
  report.numPendingTests !== 0 ||
  report.numTodoTests !== 0 ||
  report.testResults.length !== 2 ||
  JSON.stringify(passed) !== JSON.stringify(expected)
)
  throw new Error("guest-formal: the required correspondence tests did not all run and pass");
CHECK
echo "guest-formal: 27 obligations, axioms audited; $(wc -l < "$vectors" | tr -d ' ') Lean vectors replayed by 13 correspondence tests; 18 reviewed sources match"
