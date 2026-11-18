# Allocate Agent37 hosting

This Terraform configuration manages Agent37 sandbox and VM instances through
[Agent37's Sandbox API](https://www.agent37.com/docs/agents-api/instances).
It uses the [Mastercard REST API provider](https://registry.terraform.io/providers/Mastercard/restapi/3.0.0/docs),
not an Agent37-maintained Terraform provider. No instance is allocated until
`instances` is set. Each map key identifies one independent instance.

## What Agent37 provides

Agent37 runs an image from either a system template or a workspace template.
The `default` type is a gVisor sandbox; `vm` has its own kernel and can run
Docker, Compose and databases. A `performance` instance has dedicated cores.
See [templates](https://www.agent37.com/docs/agents-api/templates),
[VMs](https://www.agent37.com/docs/agents-api/vm-instances), and
[instance creation](https://www.agent37.com/docs/agents-api/instances/create).

| Setting | Agent37 contract |
|---|---|
| Regions | `us`, `eu` (France), `ap-south` (Mumbai). `default` instances run only in `us`; VM and performance types also run in the other two. |
| Shapes | 2 vCPU/4 GB, 4/8, 4/16, 4/32; VM and performance also support 8/64. The configuration rejects unsupported shapes rather than accepting Agent37's CPU rounding. |
| Disk | Default-type disks range from 2 GB to 12, 20, 40, or 80 GB by shape. VM/performance disks range from 2 to 100 GB. |
| Cost | Compute is metered while running; retained disk is charged while stopped or sleeping. The example's 2 vCPU/4 GB VM with 20 GB disk is approximately $12.80/month running continuously at the published rates on 2026-11-17. Check [current VM pricing](https://www.agent37.com/docs/agents-api/vm-instances#sizing-and-price) before applying. |
| Wallet | A funded prepaid workspace is required, including one day of the running compute rate at creation. Agent37's managed-service budget does **not** cap instance compute or disk. |
| Persistence | The selected `mount_path`, or the image user's home directory by default, is the persistent disk. Agent37 keeps nightly backups, but its backups and control-plane records are stored in the US even for EU/India instances. |
| Deletion | Deleting an instance makes its files and instance-owned backups unrecoverable; export anything needed independently first. Agent37 says a backup copy remains in its storage for seven days before being purged. |

The rates are Agent37's published estimates, not a negotiated price. Auto-sleep
is off by default because OpenSesame services and background work may need to
stay awake. Enable it only when requests are a suitable wake mechanism.

## Before allocating

1. Create and fund an Agent37 workspace and obtain a Sandbox API key. Keep the
   key in your secret manager or shell environment; do not put it in a tfvars
   file, shell history, a plan, logs, or the repository.
2. Install Terraform 1.9 or later, before 2.0. The lock file pins the REST
   provider to 3.0.0. Use one state per environment and a backend with access
   controls, encryption and locking for shared or production use. Configure
   that backend before `terraform init`; the default local state is suitable
   only for a protected local evaluation.
3. Copy `terraform.tfvars.example` to an ignored private `terraform.tfvars` and
   choose the desired instances. The example allocates an Ubuntu **VM** with
   Docker and Compose; it does not install or configure OpenSesame. Pin a
   [published template version](https://www.agent37.com/docs/agents-api/templates#pin-a-template-version)
   for reproducible allocations. Custom images must first be registered as
   workspace templates; a raw image reference is not a valid instance
   template. Agent37 copies the image and pins the resulting revision.
4. Set `REST_API_BEARER` from your secret store and run:

   ```bash
   cd ops/agent37
   bash terraform.sh init
   bash terraform.sh plan -out=agent37.tfplan
   bash terraform.sh show agent37.tfplan
   bash terraform.sh apply agent37.tfplan
   bash terraform.sh output instances
   ```

Terraform passes the key through the provider's `REST_API_BEARER` environment
variable. The configuration does not put application environment variables or
credentials in resource payloads; the generic provider otherwise stores its
payloads and API responses in state. Instance names and metadata are included
in both the API request and state, so never put secrets in them. Agent37 may
also return application log tails in a failure response. Protect state and
saved plans as sensitive data. Use the provided wrapper for every operation:
the pinned REST provider can expose the bearer token in debug logs. The wrapper
clears Terraform logging overrides and sets `TF_LOG=OFF`; it also clears other
`REST_API_*` variables so inherited settings cannot disable TLS verification or
change API methods. Do not enable logging or provider debugging with a live key.
The API origin defaults to Agent37 HTTPS. An HTTP endpoint is allowed only on
loopback when `allow_http_loopback = true`, for tests with a test-only key.

Do not import an existing instance with the pinned provider: version 3.0.0
enables request debugging during import and retains that setting in the
imported state. Terraform logging can then expose the API key. The wrapper
rejects the `import` command before starting Terraform; do not bypass it or add
Terraform `import` blocks to this configuration. For an
interrupted create, check the correct Agent37 workspace for an orphan before
retrying; a retry can allocate a second instance. Preserve any data before
retiring an orphan, or manage it outside Terraform until a safe import path is
available. If a key may have appeared in logs, protect or remove the logs and
rotate the key.

The base URL in the output is Agent37's routing URL, not a health check. By
default Agent37 requires its workspace API key on requests to instance URLs;
only supply that key to trusted operators and services, not browsers or end
users. Some system templates may create public ports themselves. This
configuration does not request a public port and does not manage ports created
elsewhere; review the chosen template and Agent37 dashboard before use. Public
ports bypass the Agent37 key requirement and need appropriate application-level
authentication and exposure review. See [instance URLs](https://www.agent37.com/docs/agents-api/urls)
and [public ports](https://www.agent37.com/docs/agents-api/public-ports).

## Run OpenSesame on the VM

After allocation, use Agent37's [SSH setup](https://www.agent37.com/docs/agents-api/ssh)
or its authenticated exec API to connect. `agent37-ubuntu` already has Docker
and Compose. Keep Docker data and any application state under the VM user's
persistent home directory; its root filesystem is an overlay. Obtain and verify
the qualified native binary using the [release kit](../../docs/operators/release-kit.md),
then configure `opensesame host run` with operator-supplied secrets and the
appropriate durable database, authorization, and ingress. The repository's
local Compose profile contains development defaults and is not a production
deployment.

For a direct container deployment, register a custom image template with an
entrypoint that stays running, the correct service port and the required
runtime configuration. OCI publication is currently retired; before using an
image, verify its availability and qualification under the current
[publication policy](../../docs/operators/publishing.md). A native Host image
needs `host run` supplied as its command. See [custom images](https://www.agent37.com/docs/agents-api/custom-image)
and the [Host operator guide](../../docs/operators/local.md). Creating a VM or
container is not evidence that OpenSesame's health and readiness checks pass.

## Updates, drift, and retirement

`name`, `metadata`, `network`, `auto_sleep`, and `idle_timeout_seconds` are
updated through Agent37's PATCH endpoint. The configuration supports
`allow-all` or `deny-all` network policy; the API's domain allowlist is not
managed here. Template, type, region, size and mount path are treated as
creation settings. A change to one, including an out-of-band change detected
on refresh, requires replacement. `prevent_destroy` blocks that replacement
and removal of an instance key, preserving its data until an operator plans a
migration. It does not protect a resource after its whole Terraform resource
block or state is removed, or from deletion outside Terraform.

To retire an instance, export and verify its data outside Agent37 first.
Then deliberately remove the `prevent_destroy` guard in this configuration,
remove only the intended instance from the map, inspect a saved plan, and
apply it. Restore the guard afterward. A stopped instance retains its disk and
continues to incur disk charges; deleting it ends billing.

The REST provider's `ignore_server_additions` option suppresses real drift in
version 3.0.0, so this configuration instead lists known response-only fields
in `ignore_changes_to`. If Agent37 adds response fields and a plan repeatedly
shows only those fields, review the API response and update that list; do not
ignore managed fields merely to silence a plan. Out-of-band changes to public
ports are outside this configuration's coverage. Terraform does not update
application images, provision application secrets, or validate app health.

The REST provider 3.0.0 can fail a refresh with `Error Parsing Plan Data` when
an instance was deleted outside Terraform and Agent37 returns 404. First verify
the instance is actually gone in the **same workspace**, rather than hidden by
a different API key. If it is gone and you intend to allocate a replacement,
back up the state, run `bash terraform.sh state rm 'restapi_object.instance["host"]'`
with the appropriate map key, then review a new plan before applying it. State
removal does not delete or recover the remote instance; a new instance has a
new identity and cannot recover its predecessor's deleted files.

## Local verification

```bash
bash terraform.sh init -backend=false
bash terraform.sh fmt -check -recursive
bash terraform.sh validate
python3 tests/test_terraform.py
```

The test runs real Terraform and the pinned provider against a local HTTP API
double; it allocates no Agent37 resources. It checks create, refresh, mutable
updates and drift, protected replacements/removal, multiple instances, missing
instance recovery, ambiguous create failure, and input validation. It is not a
live-provider or application deployment test. The candidate's nightly dev
qualification runs the same checks before recording its receipt.
