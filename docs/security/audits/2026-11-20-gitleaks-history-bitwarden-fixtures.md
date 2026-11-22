# Gitleaks history review of Bitwarden vault fixtures — 2026-11-20

## Scope

Gitleaks full-history run `44681942950` (SARIF `gitleaks-results.sarif`) reported four `generic-api-key` findings. Each is classification **(a)**: a synthetic Bitwarden vault JSON test fixture. None is an issued credential.

The four fingerprints were appended to [`.gitleaksignore`](../../../.gitleaksignore). Each entry binds one immutable commit, one path, one rule, and one line. No path is allowlisted.

## Findings

| Fingerprint | Path | Line | Commit | Rule | Classification |
|---|---|---|---|---|---|
| `6c0fbf0f37cb1785d8f1d5c4dd9ba5183a53ebcc:crates/provider-bitwarden/tests/fixtures/cloud.json:generic-api-key:121` | `crates/provider-bitwarden/tests/fixtures/cloud.json` | 121 | `6c0fbf0f37cb` | `generic-api-key` | (a) synthetic fixture |
| `6c0fbf0f37cb1785d8f1d5c4dd9ba5183a53ebcc:crates/provider-bitwarden/tests/fixtures/vaultwarden.json:generic-api-key:122` | `crates/provider-bitwarden/tests/fixtures/vaultwarden.json` | 122 | `6c0fbf0f37cb` | `generic-api-key` | (a) synthetic fixture |
| `f11c169d77f5b3681e64188a6fdaa834246cd50b:crates/provider-bitwarden/tests/fixtures/cloud.json:generic-api-key:121` | `crates/provider-bitwarden/tests/fixtures/cloud.json` | 121 | `f11c169d77f5` | `generic-api-key` | (a) synthetic fixture |
| `f11c169d77f5b3681e64188a6fdaa834246cd50b:crates/provider-bitwarden/tests/fixtures/vaultwarden.json:generic-api-key:122` | `crates/provider-bitwarden/tests/fixtures/vaultwarden.json` | 122 | `f11c169d77f5` | `generic-api-key` | (a) synthetic fixture |

`6c0fbf0f37cb` is `feat: finish production readiness and add Agent37 hosting (#2768)` on main. `f11c169d77f5` is `test: consolidate deterministic Bitwarden fixtures`, the commit that introduced these fixtures.

## Attestation

The matched line in every finding is a Bitwarden cipher envelope string, and it appears only in the checked-in test JSON under `crates/provider-bitwarden/tests/fixtures/`.

At both commits the line is the login password of the cipher whose id is the fixed COSE fixture id `77777777-7777-4777-8777-777777777777`:

- `cloud.json` line 121 is the PascalCase `Password` field inside `Login`.
- `vaultwarden.json` line 122 is the camelCase `password` field inside `login`.

Each value is a Bitwarden `EncString` of encryption type 7: one base64 payload, with no symmetric-cipher pipe separators. The two commits carry the same line bytes for each file. These strings are generated as fixture material. They are not issued credentials, API keys, or live vault contents. This note does not quote them.

`crates/provider-bitwarden/tests` is the consumer:

- `tests/common/mod.rs` builds the envelope in `build_fixtures` and `load_fixture` reads `tests/fixtures/{cloud,vaultwarden}.json` for the loopback stub (`vaultwarden_routes`, `cloud_identity_routes`, `cloud_api_routes`).
- `tests/fixtures_gen.rs` checks that the committed JSON matches the generator (`committed_fixtures_match_the_generator`) and that both server topologies are covered.
- `tests/api_stub.rs` drives the cloud and vaultwarden topologies through that stub. The crate README states that these tests replay the recorded fixtures on loopback and do not use the network.

## Disposition

Historical exceptions only. A later commit that changes the line, or any other value in those files, stays visible to the scanner.
