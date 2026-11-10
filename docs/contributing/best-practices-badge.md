# OpenSSF Best Practices badge — answer preparation

An assessment already exists:
[project 15954](https://www.bestpractices.dev/projects/15954), at 93% of
Passing when last checked (2026-11-09). Scorecard still reports 0 for
CII-Best-Practices because that assessment's `repo_url` is the pre-transfer
`https://github.com/Tyler-R-Kendrick/OpenSesame`; Scorecard looks the
project up by this repository's URL and finds nothing.

Maintainer steps, in order:

1. Sign in to bestpractices.dev as the project owner and edit project 15954:
   set `repo_url` to `https://github.com/OpenSesame-Labs/OpenSesame` and
   `homepage_url` to `https://opensesame-labs.github.io/OpenSesame/`.
2. Finish the remaining Passing criteria using the evidence table below.
3. Add the badge to the README (see "After filing").

Each row below names the repository evidence to paste into the matching
criterion's justification field.

Target order: **Passing** first, then Silver. Do not claim a criterion that
the linked evidence does not actually support — several are marked *gap*
below on purpose.

## Basics

| Criterion (form wording, abbreviated) | Answer | Evidence |
|---|---|---|
| Project website describes what the software does | Met | README first section; <https://opensesame-labs.github.io/OpenSesame/> |
| Interactive discussion / contribution info | Met | `CONTRIBUTING.md`, `docs/contributing/` |
| FLOSS license, OSI-approved, in standard location | Met | `LICENSE` (MIT). Only the fuzz submission packs carry Apache-2.0 headers, for their upstream repos |
| Documentation: basics, interface, installation | Met | `docs/getting-started/README.md`, `docs/README.md`, `docs/architecture/README.md` |
| Accessibility / i18n (should-level) | Partial | Pages app follows platform conventions; no formal a11y statement — answer honestly |
| Sites support HTTPS | Met | GitHub Pages + github.com over HTTPS |

## Change control

| Criterion | Answer | Evidence |
|---|---|---|
| Public version control with history | Met | This repository (git, GitHub) |
| Unique version numbering / release notes | Met | `docs/CHANGELOG.md`; release kit (ADR 0212) tags `v*` |
| Releases are signed / provenance | Met | `.github/workflows/release-kit.yml` — build provenance attestations + SHA256SUMS |

## Reporting

| Criterion | Answer | Evidence |
|---|---|---|
| Bug reporting process + archive | Met | GitHub Issues (public archive) |
| Vulnerability reporting process, private channel | Met | `SECURITY.md` + GitHub private advisories |
| Response times | Met | `SECURITY.md`: acknowledge 3 business days, assessment 10, response ≤14 days |

## Quality

| Criterion | Answer | Evidence |
|---|---|---|
| Working build system (standard tools) | Met | `package.json` (pnpm), `Cargo.toml` workspaces |
| Automated test suite, run in CI | Met | `.github/workflows/ci.yml` and companion workflows; required status checks on `main` |
| New functionality adds tests (should-level) | Met | Test trees beside `crates/`, `packages/`, `apps/`; CI gates |
| Warning flags / linters, fixed or justified | Met | biome + oxlint configs, `clippy.toml`, quality gates in `scripts/quality/` |

## Security

| Criterion | Answer | Evidence |
|---|---|---|
| At least one developer knows secure design | Met | `docs/security/` (threat model), `security-insights.yml` |
| Crypto: published algorithms, no broken defaults, no custom crypto | Verify per-claim | Workspace uses standard crates (see `Cargo.toml` dependency notes); answer algorithm-by-algorithm in the form |
| Secured delivery (signed checksums / TLS) | Met | Release-kit attestations; HTTPS distribution |
| No leaked credentials in repo | Met | gitleaks pre-commit + scheduled scan (`.github/workflows/security.yml`), push protection enabled |
| Static analysis (SAST) at least one tool, fixed findings | Met | CodeQL (`.github/workflows/codeql.yml`, six languages) |
| Dynamic analysis / fuzzing | Met | cargo-fuzz + Jazzer.js targets under `tests/fuzz/`; OSS-Fuzz enrollment filed |

## Analysis

| Criterion | Answer | Evidence |
|---|---|---|
| Static analysis for common vulnerabilities | Met | CodeQL + OSV-Scanner schedule in `security.yml` |
| Dynamic checks (assertions, fuzzing, sanitizers) | Met | `tests/fuzz/` (48 cargo-fuzz targets, 16 Jazzer.js targets) |

## Known gaps to close or answer honestly

- Bus-factor / contributor diversity statements (Silver-level mostly).
- Any criterion asking for two-person review: the project is currently
  single-maintainer; branch rules require reviews with an admin bypass.
  Answer truthfully; Passing does not require two reviewers.

## After filing

1. Add the badge beside the Scorecard badge in `README.md`:
   `[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15954/badge)](https://www.bestpractices.dev/projects/15954)`
2. Update `docs/contributing/oss-programs.md`: move Best Practices from
   "Recommended next" to "Enrolled" with the project link.
