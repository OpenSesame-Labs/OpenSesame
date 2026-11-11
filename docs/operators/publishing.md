# Publishing OpenSesame artifacts

The supported entry point is **Weekly release** on `main`
(`.github/workflows/release-weekly.yml`). It selects a dev-qualified immutable
candidate, requires prerelease, mutation and security, and promotes the stored
Pages and Linux kits. See [CI and artifact promotion](ci-promotion.md) for
schedules, versions, settings, evidence and recovery.

## Pages and native kits

Nightly production stamps the Pages runtime/profile/release metadata before
qualification. Publication verifies the complete candidate, deploys unchanged
Pages files through Actions and checks the served source and content. Native
releases contain the same qualified archives, original build proof, receipts
and promotion evidence.

Tag creation is owner-only. Configure `RELEASE_PUBLISH_TOKEN` as a protected
`release` environment secret: the admin's fine-grained token whose only
repository permission is Contents read/write on this repository
([its rules](#keep-release_publish_token-short-lived)).
The ordinary Actions token cannot create version tags; staging fails closed if
the protected credential is absent.

The old `deploy-pages.yml`, `release-kit.yml` and local
`scripts/release/deploy-pages.sh` paths now fail with a migration message.
Manual releases use the same nightly/weekly controllers and gates. A tag push
cannot start another native build. See [Release kit](release-kit.md) for consumer
verification and separately named test proxy downloads.

## Container and npm publication

The old `publish-containers.yml` and `publish-npm.yml` publishers are retired.
They rebuilt outside candidate qualification; their manual entry points now
fail without publication permissions. Container build validation still runs
in prerelease.

Restoring these distributions requires OCI digests/npm tarballs in the immutable
candidate inventory, tests of those payloads and candidate-bound publishing.
An npm token or tag alone must not restore the old rebuild-and-publish path.

## Stored publication credentials

Two credentials outlive a workflow run, and each run that uses one says so.

| Secret | Environment | Used by | Shown as |
|---|---|---|---|
| `NPM_TOKEN` | `Preview`, `Production` | `cd-npm-cli.yml`, `cd-pwa.yml` through `.github/actions/publish-npm-package` | A warning on every publish that reads it; a notice when the publish used OIDC instead |
| `RELEASE_PUBLISH_TOKEN` | `release` | The stage job of `release-publish.yml` | Its expiry date on every release, as a warning when it never expires, expires within 14 days, or expires more than 90 days out |

Neither message contains a credential's value. `scripts/release/credential-expiry.mjs`
reads the kind from the token's public prefix and the date from GitHub's
`github-authentication-token-expiration` response header.

### Retire `NPM_TOKEN`

The publish action already publishes with OIDC when the token is empty, the
publish jobs already hold `id-token: write`, and the rows to configure are in
`npm_trusted_publishing.publishers` of
[`docs/ci/github-setup-spec.json`](../ci/github-setup-spec.json). Nothing in
the repository has to change. On npmjs.com, as the package owner:

1. For each of the four rows (two packages, `Preview` and `Production`), add a
   trusted publisher to the package: GitHub Actions, the organization, the
   repository, the workflow filename and the environment name. npm matches
   every field exactly, including case, and does not check them when saved: a
   mistake only shows at the next publish.
2. Delete `NPM_TOKEN` from the `Preview` environment. The next `main` push
   that publishes `0.0.0-alpha.N` must show the notice
   "This publish uses OIDC trusted publishing". npm drops a new trusted
   publisher that has not published within two days, so do this soon after
   step 1. If the publish fails, restore the secret, correct the row and try
   again.
3. Delete `NPM_TOKEN` from the `Production` environment and confirm the same
   notice on the next `0.0.0-next.N` publish.
4. For each package, under Settings, Publishing access, select "Require
   two-factor authentication and disallow tokens", then revoke the old token.
   After this a stolen token cannot publish even if one is created again.

What trusted publishing requires is already true here: the publish jobs run on
GitHub-hosted runners, the action pins an npm newer than 11.5.1 on Node 24,
the publish step is in the workflow file npm is told about (not a reusable
workflow), and each published `package.json` names this repository.

### Keep `RELEASE_PUBLISH_TOKEN` short-lived

The release stage creates the version tag. Both tag rulesets
(`ops/github/release-tags.json`, `release-tag-creation.json`) let one actor
through: the repository admin role. So the credential is the admin's own
fine-grained personal access token, and its rules are:

- limited to this repository, with Contents read and write and nothing else;
- expiring in 90 days or less;
- stored only as the `release` environment secret.

Every release run reports the token's expiry date. It warns when the token
has no expiry date, expires within 14 days, or expires more than 90 days out.
Rotate it when the run warns: create the new token, replace the environment
secret, then revoke the old one. A classic token, or any token without an
expiry date, is reported as a warning on every release until it is replaced.

A GitHub App token would last an hour, but it is not the admin role: the App
would have to be added as a bypass actor to both tag rulesets, which widens
who can create and move release tags from one person to an installed app.
That trade is not made here. If it ever is, the expiry report already
recognises an App token and says so.

## Other hosting providers

A Vercel or other provider Git integration that rebuilds on every main push is
a separate policy. It does not consume the qualified Pages artifact and is
outside this initial publisher. Review such external automatic deployments when
adopting the weekly production cadence.

The Pages product is static and device-local. Do not reintroduce Identity,
Host or daemon endpoints into its runtime configuration: the existing writer
enforces that boundary. Hosted Identity/Host services have their own operator
configuration under `ops/compose/`.
