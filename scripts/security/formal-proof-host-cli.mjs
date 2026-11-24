import { SPIFFE_PEER_DOMAIN_SUITE } from "./formal-proof-spiffe-peer-domain.mjs";

// Independently reviewed CLI-WA1–WA3, RELAY-T1 and RELAY-F1 contract. The Host
// gateway closure is the same reviewed manifest set as the SPIFFE peer-domain
// suite.
const GATEWAY_MANIFESTS = SPIFFE_PEER_DOMAIN_SUITE.manifestProjection.manifests;
export const HOST_CLI_SUITE = {
  id: "host-cli",
  implementation: [
    "crates/cli-app-integration/src/lib.rs",
    "crates/cli-app-integration/src/policy.rs",
    "crates/cli-app-integration/src/human_proof.rs",
    "crates/cli-app-integration/src/webauthn_assertion.rs",
    "crates/cli-app-integration/src/device_crypto.rs",
    "crates/cli-app-integration/src/pairing.rs",
    "crates/cli-app-integration/src/pairing/binding.rs",
    "crates/cli-app-integration/src/pairing_code.rs",
    "crates/cli-app-integration/src/test_support.rs",
    "crates/cli-app-integration/src/webauthn_high_risk_tests.rs",
    "crates/cli-app-integration/src/webauthn_registration_tests.rs",
    "spec/conformance/cli-app-integration.json",
    "crates/gateway/src/middleware/auth.rs",
    "crates/gateway/src/routes/mod.rs",
    "crates/gateway/src/routes/relay.rs",
    "crates/gateway/src/routes/relay_scope.rs",
    "crates/gateway/src/routes/relay_tests.rs",
    "crates/gateway/src/routes/relay_tenant_tests.rs",
    "crates/gateway/src/routes/intents.rs",
    "crates/gateway/src/routes/intents_queue.rs",
    "crates/gateway/src/routes/intents_relay_mode_tests.rs",
    "crates/connection-broker/src/delegation.rs",
    "crates/connection-broker/src/delegation_mode.rs",
    "crates/connection-broker/src/delegation_lineage.rs",
    "crates/connection-broker/src/tests/delegation_mode_tests.rs",
    "crates/relay/src/lib.rs",
    ...GATEWAY_MANIFESTS,
    "crates/Cargo.toml",
    ...GATEWAY_MANIFESTS.map((path) =>
      path.replace(/Cargo\.toml$/u, "build.rs"),
    ),
  ],
  lockProjection: { path: "Cargo.lock", root: "opensesame-gateway" },
  manifestProjection: {
    path: "Cargo.toml",
    package: "crates/gateway/Cargo.toml",
    lock: "Cargo.lock",
    root: "opensesame-gateway",
    manifests: GATEWAY_MANIFESTS,
  },
  proofs: [
    "spec/formal/host-cli/HostCli.lean",
    "spec/formal/host-cli/required-theorems.lean",
    "spec/formal/host-cli/verify.sh",
    "spec/formal/required-theorem-command.lean",
    "spec/formal/check-axioms.sh",
    "spec/formal/check-axioms.test.mjs",
  ],
  command: ["npm", "run", "verify:host-cli-formal"],
};

// Independently reviewed INV-I1, INV-O1, INV-O2, INV-D1 and INV-D2 contract,
// rooted at the gateway, which composes every mapped crate.
const crate = (dir, names) =>
  names.split(" ").map((name) => `crates/${dir}/${name}.rs`);
const invocationProof =
  "Invocation InvocationEffects InvocationGateway required-theorems";
export const INVOCATION_SUITE = {
  id: "invocation",
  implementation: [
    ...crate(
      "broker/src",
      "idempotency lib frozen independent_executor frozen_outcome_tests",
    ),
    "crates/audit/src/lib.rs",
    "crates/domain/src/receipt.rs",
    "crates/broker/tests/adversarial_broker/invocation_binding.rs",
    "crates/gateway/Cargo.toml",
    "crates/broker/tests/adversarial_broker/outcome_indeterminate.rs",
    "crates/connection-broker/src/egress_json.rs",
    ...crate(
      "connector-host/src",
      "builtin_connector invocation_binding invocation_dispatch",
    ),
    ...crate(
      "connector-host/src",
      "binding_test_fixtures invocation_binding_tests",
    ),
    "crates/connection-broker/src/tests/owner_egress_vectors.rs",
    "crates/broker/src/frozen_recovery.rs",
    "crates/gateway/src/middleware/auth.rs",
    ...crate(
      "gateway/src/routes",
      "tasks_opening tasks_bootstrap_tests tasks_opening_tests",
    ),
    ...crate("gateway/src/routes", "intents_budget intents_effect_fence_tests"),
    ...crate("gateway/src", "connector_egress connector_egress_binding_tests"),
  ],
  lockProjection: { path: "Cargo.lock", root: "opensesame-gateway" },
  manifestProjection: {
    path: "Cargo.toml",
    package: "crates/gateway/Cargo.toml",
    lock: "Cargo.lock",
    root: "opensesame-gateway",
  },
  proofs: [
    ...invocationProof
      .split(" ")
      .map((name) => `spec/formal/invocation/${name}.lean`),
    "spec/formal/invocation/verify.sh",
    "spec/formal/invocation/coverage.json",
    "spec/formal/required-theorem-command.lean",
    "spec/formal/check-axioms.sh",
    "spec/formal/check-axioms.test.mjs",
  ],
  command: ["npm", "run", "verify:invocation-formal"],
};
