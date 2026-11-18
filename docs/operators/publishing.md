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

The weekly release uses the protected `RELEASE_PUBLISH_TOKEN` described below.
An `NPM_TOKEN` may still exist in a GitHub environment, but current CD jobs do
not read it and the shared npm publish action fails closed. No npm package is
published until candidate-bound promotion is implemented; existing registry
versions and tags remain unchanged. Remove any unused long-lived npm token
through the normal owner-controlled credential process.

The preserved, currently unreachable npm publication code verifies a pinned
npm CLI, packs without credentials, isolates npm configuration, and compares
registry integrity on reruns. Re-enabling it requires npm tarballs in the
immutable candidate inventory, qualification and provenance for those exact
bytes, and promotion without rebuilding. It also requires independently
configured protected publishing environments and npm trusted publisher policy.
A token or an environment setting alone does not enable publication.

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
A token GitHub refuses as expired or revoked fails that step, with the reason,
before anything is published.

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

[Agent37](../../ops/agent37/README.md) is an allocation option for sandboxes
and VMs. Its Terraform configuration does not publish or deploy a release;
choose a qualified artifact and configure the workload separately.

The Pages product is static and device-local. Do not reintroduce Identity,
Host or daemon endpoints into its runtime configuration: the existing writer
enforces that boundary. Hosted Identity/Host services have their own operator
configuration under `ops/compose/`.
