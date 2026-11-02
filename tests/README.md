# tests/

Test suites that exercise more than one package or crate, and the fixtures
several of them share. A test that covers one package lives next to that
package's code instead (`*.test.ts` beside the source, `tests/` inside a
crate).

| Directory | Kind | What it proves | Run |
|---|---|---|---|
| [`fixtures/`](fixtures) | Shared data | Committed inputs both planes are checked against: KDBX round-trip vectors, a demo `.env.schema`. | — |
| [`fuzz/cargo/`](fuzz/cargo) | cargo-fuzz (Rust) | Parsers and state machines survive arbitrary input: tokens, manifests, KDBX, NATS callouts, certificate requests. Seeds in `corpus/`; a minimized crasher is committed under `regressions/<target>/` (none are committed yet). | `npm run audit:fuzz` (short) · `npm run audit:fuzz:batch` |
| [`fuzz/jazzer/`](fuzz/jazzer) | Jazzer.js (TypeScript) | The same for the Identity plane: contracts, agent-auth tokens, audit redaction, claim engine. | `npm run test:fuzz` · `npm run test:fuzz:batch` |
| [`fuzz/clusterfuzzlite/`](fuzz/clusterfuzzlite) | OSS-Fuzz builder | Builds every cargo-fuzz target for ClusterFuzzLite. Not wired to CI. | — |
| [`redteam/`](redteam) | promptfoo + Vitest | The real `packages/mcp-host` stdio server under prompt-injection, confused-deputy, exfiltration and malformed-input attacks, behind a stub Host API and daemon. | `npm run test:redteam` (promptfoo corpus); its Vitest suites, including the structural pact suite, run under `npm test` |
| [`visual-contract/`](visual-contract) | Playwright + pixelmatch | The Pages app still matches its design baselines in `tests/visual-contract/baselines/`. | `npm run test:visual` |
| [`mtls-interop/`](mtls-interop) | Rust integration crate | Optional mTLS interoperates across runtimes: Rust ↔ Node listeners, nats-server, OpenBao `auth/cert`, SPIRE, a Caddy ingress. Ignored unless `OPENSESAME_MTLS_FIXTURES=1`. | `npm run test:mtls:integration` |

The cargo-fuzz project is deliberately **outside** the Cargo workspace
(`exclude` in the root `Cargo.toml`) because it needs nightly Rust; it has its
own `Cargo.lock`. Method and coverage: [docs/validation/fuzzing.md](../docs/validation/fuzzing.md).

## The rest of the test pyramid

| Layer | Where | Command |
|---|---|---|
| Unit and property tests (TypeScript) | beside the source, `*.test.ts` | `npm test` |
| Unit and integration tests (Rust) | `src/**` `#[cfg(test)]` and each crate's `tests/` | `cargo +1.88.0 test --workspace --all-targets` |
| PACT suites — property, adversarial, chaos, contract | `pact.test.ts` and `*.pact.test.ts`, per package | part of `npm test`; see [docs/validation/pact.md](../docs/validation/pact.md) |
| Browser journeys on a real build | `apps/pages/scripts/verify-*.mjs` | `npm run verify:<journey>` -w @opensesame/pages |
| Security gates | `scripts/audit/*-gate.sh` | `npm run audit:*`, `npm run test:security` |
| Coverage and mutation | `scripts/quality/ts-coverage-gate.mjs`, [`tools/mutation/`](../tools/mutation) | `npm run test:coverage`, `npm run test:mutation` |

The full strategy — what each layer is for and what it may not be used to
claim — is in [docs/validation/test-strategy.md](../docs/validation/test-strategy.md).

## Adding a suite

Put it here only if it spans packages or needs its own toolchain. A
TypeScript suite also needs a line in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)
and a `test` script so `npm test` runs it.
