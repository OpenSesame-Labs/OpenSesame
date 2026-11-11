# Dependency supply chain

A dependency is code written by someone else that runs with our access. This page records how the repository defends against a malicious or hijacked package, following GitHub's [Defending against dependency supply chain attacks](https://learn.github.com/well-architected/application-security/recommendations/managing-dependency-threats). No single layer is enough; each covers a gap the others leave.

## The layers

| Layer | Control | Status |
|---|---|---|
| 1. No code runs at install | [`.npmrc`](../../.npmrc) sets `ignore-scripts=true` for every contributor and agent. Most CI jobs use a sparse checkout that leaves `.npmrc` out, and an image build sees only its context, so every `npm ci` in a workflow or a product Dockerfile also passes `--ignore-scripts` explicitly; a [test](../../scripts/lib/developer-workspace.test.mjs) fails on one that does not. `save-exact=true` records a new dependency at the version that was reviewed. | Enforced |
| 1. Deterministic installs | `npm ci` against the committed lockfile everywhere; Cargo and Go lockfiles are committed. | Enforced |
| 2. Isolation | A hardened [dev container](developer-workspace.md); cloud agents run in per-session sandboxes. | Enforced, not mandatory |
| 3. Signed commits | Required by the default-branch ruleset; every pull-request commit must be GitHub-verified. Agent keys sign without a human gesture, which is a recorded deviation ([ADR 0222](../adr/0222-github-well-architected-and-ssdf.md)). | Declared, with a deviation |
| 4. Rulesets | Pull request, reviews and required checks before anything reaches `main` ([declaration](../../ops/github/default-branch.json)). | Declared |
| 5. Publishing | npm packages publish with `--provenance`; candidates carry attested build provenance. Trusted publishing over OIDC is used whenever `NPM_TOKEN` is absent, and a publish that still reads the token raises a warning ([steps to remove it](../operators/publishing.md#stored-publication-credentials)). | Enforced; removing the token is an Owner setting |
| 5. Consuming | `npm audit signatures` verifies the registry signature of every installed package, and every provenance attestation a package publishes, weekly ([workflow](../../.github/workflows/security.yml)). | Enforced |
| 6. Detection | OSV-Scanner, cargo-audit and cve-lite gates over every lockfile; [dependency review](../../.github/workflows/dependency-review.yml) on the pull request that changes one; Dependabot alerts and security updates declared. | Enforced and Declared |

## Lifecycle scripts

Nine packages in the lockfile declare an install script. None is needed:

| Package | What its script does | Without it |
|---|---|---|
| `esbuild` | Validates the platform binary | The binary arrives as an optional dependency and works |
| `agent-browser` | Marks the bundled binary executable; downloads one if missing | The binaries ship in the tarball and the launcher runs them |
| `ssh2`, `cpu-features` | Compile optional native acceleration | Pure JavaScript fallback |
| `protobufjs` (four copies) | Prints a version notice | Nothing lost |
| `fsevents` | macOS only; ships prebuilt | Nothing lost |

No workspace declares a `pre*` or `post*` npm script, so `ignore-scripts` changes nothing about `npm run`.

### When a package needs its script

1. Read the script. Know what it downloads and runs.
2. Check who publishes the package and whether that changed recently.
3. Run it for that package alone:

   ```bash
   npm rebuild <package> --ignore-scripts=false
   ```

4. Add the package to the table above in the same pull request, with the reason.

Do not remove `ignore-scripts` from `.npmrc`, do not drop the flag from an install step, and do not add a root `postinstall`.

## Updating a dependency

Dependabot proposes updates weekly, grouped, for npm, Cargo, GitHub Actions and the base images of the product Dockerfiles ([configuration](../../.github/dependabot.yml)). Two rules apply to every update, however small:

- **Seven-day cooldown.** A version published less than a week ago is not proposed. A hijacked release is usually reported and withdrawn within days. Security updates are not delayed.
- **A person reviews it.** Nothing auto-merges. A patch release is not safer than a major one: attackers ship malicious code as patches because patches get less scrutiny.

When reviewing: read the changelog; look for a change of maintainer or publishing pattern; read the diff for anything with broad access; prefer a dependency that publishes provenance. Record why a version was held back in the pull request or in the `ignore` block of `dependabot.yml`, as the existing entries do.

Before adding a dependency, ask whether a mature library already in the tree does the job ([ADR 0008](../adr/0008-better-auth-oidc-provider.md)). A package name suggested by an AI assistant is checked against the registry by hand before it is installed: attackers register the names assistants tend to invent.

## Decisions

- Patches to dependencies are installed from vendored tarballs pinned in the lockfile, because npm does not apply `patchedDependencies` ([`patches/README.md`](../../patches/README.md)). A weekly job rebuilds each tarball from the published package and its patch and compares the bytes.
- No allow-list of approved dependencies and no private registry mirror: with one maintainer, the cooldown, dependency review, the advisory gates and scripts-off installs are the controls, and a mirror would add an account to protect without adding a reviewer.
