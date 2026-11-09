# TURN test fixture

`live-turn` supplies the UDP, TCP and TLS relay transports used by the real
browser live-session tests. Build and run it through
`scripts/test/live-fixtures.sh`.

## Cryptography source maintenance

The upstream `golang.org/x/crypto` module still distributes the unsupported
OpenPGP implementation identified by GO-2026-5932, with no fixed module version.
TURN's Pion DTLS dependency needs only cryptobyte and ChaCha20-Poly1305. The local
replacement in `third_party/x-crypto` contains those upstream packages and their
dependencies, original tests, architecture implementations, LICENSE and
PATENTS. It physically excludes OpenPGP and the other unused packages. It keeps
the real upstream module identity; the cryptographic source is unchanged.

`UPSTREAM.json` records the upstream release, commit, module checksum and every
included file's SHA-256. `chacha20/vectors_test.go` and
`internal/poly1305/vectors_test.go` are not stored in the tree; their digests
stay under `test_vector_files`. `audit-crypto.sh` checks those bytes against
the checksum-verified module from `go mod download -json`, then runs `go test
-overlay` so those upstream files are compiled. Use that script to test this
module. A plain `go test` does not include those vectors.
`chacha20poly1305/chacha20poly1305_vectors_test.go` stays vendored. Only
`go.mod` and `go.sum` describe a smaller dependency set. This source subset is
maintained here; upstream does not publish it as a separate release.

Run the mandatory companion audit whenever scanning dependency advisories:

```sh
bash scripts/test/live-turn/audit-crypto.sh
```

Set `OPENSESAME_GO_BIN` if the pinned Go toolchain is outside `PATH`. The audit
first rejects changed, missing, additional or symlinked source, then checks exact
bytes against the checksum-verified canonical upstream release. It runs upstream
tests for optimized and generic implementations. Finally, pinned govulncheck
scans a temporary copy of the real TURN module with the local replacement
removed, using the original upstream version. Package-level analysis reports
every advisory in any imported package, rather than relying on function-level
reachability. The audit also verifies that every included source package is in
that analyzed import graph; a dependency change cannot silently leave source
without advisory coverage. Scanner failures fail the audit. No advisory
exceptions are used.

**Raw OSV module scanning omits local replacements.** A clean OSV result alone
does not establish advisory coverage for this source. Both the ordinary OSV gate
and this companion audit must pass. OpenPGP is absent from both the subset and
the actual imported package graph; the companion audit retains current upstream
advisory coverage for the included cryptography.

When updating, download the exact new upstream version with `go mod download
-json`, copy the same complete package directories and licenses without editing
source, leave the two overlay vector tests out of the tree, record their
hashes in `test_vector_files`, regenerate the other file hashes and provenance,
and update the main module's required version. Review upstream changes and dependency requirements, then run
the companion audit and TURN/browser transport tests. A changed package boundary
requires review of the verifier and its dependency coverage too.

Pion's upstream randomness-failure test overrides `crypto/rand.Reader`. Go 1.26
ignores that override by default. Its isolated legacy test harness can use
`GODEBUG=cryptocustomrand=1` to exercise the mocked failure path. Do not set that
switch for fixture builds, relay tests or normal execution: those retain the
default Go randomness behavior. The real UDP/TCP/TLS allocation and bidirectional
relay tests run with race detection and the default runtime settings.
