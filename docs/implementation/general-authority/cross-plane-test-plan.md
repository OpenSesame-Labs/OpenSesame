# Cross-plane authority test plan (GA-Q-02)

One map of how Host, Identity, and shared domain prove hierarchical authority
without claiming a second ledger. Run the **plane commands** below; the fabric
gate aggregates scenario status.

## 1. Shared domain (both planes)

| Concern | Command |
|---|---|
| TS AuthorityGrant / INV-GA asserts | `npm exec -w @opensesame/os-domain -- vitest run src/__tests__/authority-grant.test.ts` |
| Wire schema (GA-A-04) | `npm exec -w @opensesame/contracts -- vitest run src/__tests__/authority-grant.test.ts` |
| OpenFGA tuple mapper (GA-F-02) | `npm exec -w @opensesame/policy -- vitest run src/__tests__/authority-tuples.test.ts` |
| Tuple backfill dry-run (GA-F-04) | `npm exec -w @opensesame/policy -- vitest run src/__tests__/authority-tuple-backfill.test.ts` |
| Rust Grant attenuation / AT-* | `cargo +1.88.0 test -p opensesame-domain --lib -- authority_adversarial_matrix::` |
| Receipt delegation binding (GA-H-04) | `cargo +1.88.0 test -p opensesame-domain --lib validated_grant_chain::tests::receipt_chain_binds_grant_or_lineage` |

## 2. Host plane

| Concern | Command |
|---|---|
| Authz model + engine | `cargo +1.88.0 test -p opensesame-authz --lib` |
| Storage fence / budgets / projection | `cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix` |
| Broker frozen receipts | `cargo +1.88.0 test -p opensesame-broker --lib` |
| OpenFGA additivity (GA-F-03) | `npm exec -w @opensesame/policy -- vitest run src/__tests__/authority-additivity.test.ts` |

## 3. Identity plane

| Concern | Command |
|---|---|
| `/v1/authority` spawn + PoP + audit | `npm exec -w @opensesame/control-plane -- vitest run src/__tests__/authority-routes.test.ts` |
| Membership subject-kind fence | `npm exec -w @opensesame/database -- vitest run tests/schema-metadata.test.ts -t 'membership subject kinds\|enum-like text'` |
| Live membership reconcile (GA-I-02) | `npm exec -w @opensesame/control-plane -- vitest run src/__tests__/authority-membership-reconcile-live.test.ts` |
| Membership edge store apply | `npm exec -w @opensesame/database -- vitest run tests/authority-membership-edges.test.ts` |

## 4. Fabric aggregation

```bash
npm run test:authority-fabric
# or
npm run test:authority-fabric:report
```

Writes `work/evidence/general-authority/authority/cross-platform/authority-fabric-report.{json,md}`.
Live Discord / OpenBao remain env-gated provider rows; shuttle interleaving (GA-V-29) is wired —
they do not greenwash the gate.

## 5. Still outside this plan

- Pages visual evidence (GA-P-02 / GA-Q-03).
- Standing matrix honesty ratchet (GA-O-04) — never closes.
