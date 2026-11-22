# Implementation records

Working documents for features built out across many pull requests: the
baseline they started from, who owns which part, the contracts between parts,
and the test plans that say when they are done. They are records of work in
progress, not descriptions of the finished system — for that, read
[architecture](../architecture/README.md). When a programme finishes, its
binding decisions move to ADRs or current-state evidence and the working record
is retired to Git history under the [repository footprint contract](../contributing/repository-footprint.md).
The status column below is as of 2026-10-08; a document whose body no longer
reads as current opens with a dated status line of its own.

| Programme | Documents | Status |
|---|---|---|
| [Native host and self-issued identity](native-host/README.md) ([ADR 0138](../adr/0138-self-issued-identity-one-native-host.md), proposed) | [Plan](native-host/README.md): one native process per machine, identity self-issued by default, MCP in every app, `apps/` reduced to products | Live, partly landed |
| [General authority](general-authority) ([ADR 0120](../adr/0120-generalized-hierarchical-authority.md)) | [Ownership](general-authority/ownership.md) · [storage](general-authority/storage.md) · [compatibility map](general-authority/compatibility-map.md) · [Host route inventory](general-authority/host-authority-route-inventory.md) · [panel gating](general-authority/panel-gating.md) · [cross-plane test plan](general-authority/cross-plane-test-plan.md) · [adversarial matrix](general-authority/adversarial-matrix.md) · `completion-matrix.json` · `contract-registry.json` · `local-ledger-inventory.json` | Landed; retained records are still consumed by gates or current source contracts |
| [Capability composition](capability-composition) ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)) | [Ownership and interface contract](capability-composition/ownership.md) | Landed; retained because source and tests cite its section-level contract |

Completed programme plans and point-in-time baselines are retired to Git
history once their decisions have canonical ADR, architecture, operator, and
test coverage. The exact retirement map is recorded in the
[repository-footprint contract](../contributing/repository-footprint.md).
