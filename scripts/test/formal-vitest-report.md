# Formal correspondence report guard

The auth, OAuth and WebAuthn proof runners save Vitest's JSON report and pass it,
together with the Lean-generated vectors, to `formal-vitest-report.mjs`. The
guard requires the exact files and named tests, passing status for every result,
consistent totals, and no failed, skipped or pending cases. An empty, malformed,
missing, duplicate or unexpected report fails the runner.

The guard checks every vector input belongs to the expected Cartesian matrix,
appears once, and has an output in its modeled domain. Auth requires 240 session,
eight principal and 160 project comparisons plus the inventory test. Session
and project names use the same scalar tuple values passed to their callbacks,
so the report must match each Lean input exactly once even though Vitest
otherwise truncates array-valued titles.
OAuth requires all 16 legacy and 81 current-provenance comparisons, both
inventories, and the 13 named pending-state security tests. WebAuthn requires
one input-keyed comparison for each of its 3,072 vectors and three other named
tests, including the inventory.

Run `node --test scripts/test/formal-vitest-report.test.mjs` for the guard's
boundary tests. `python3 scripts/test/formal-vitest-report-negative-controls.py`
runs the real proof runners against isolated skipped, renamed, duplicate-case,
subset, malformed-output and missing-report mutations; it never edits the live
test or model files. The unmodified runners must pass before and after the
mutations.

These checks assume Vitest's JSON report faithfully describes the executed
tests and that the reviewed callback code uses its tuple arguments to perform
the stated comparisons. A callback that ignores those arguments can preserve
every reported title while repeatedly checking the same case; report checking
alone cannot detect that alteration. The scratch controls demonstrate this
separately for auth session and project callbacks, without treating their
acceptance as a passing security control. This guard neither proves
implementation refinement nor verifies the cryptographic or concurrency
assumptions of the underlying models.
