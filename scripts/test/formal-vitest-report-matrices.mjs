/** Abstract case matrices and required test names for formal-vitest-report.mjs. */

const bits = ["0", "1"];
const assurance = [
  "missing",
  "provisional",
  "self_asserted",
  "verified",
  "mfa",
  "phishing_resistant",
  "enterprise_managed",
  "workload_attested",
];
const projectStates = [
  "provisional",
  "active",
  "expired",
  "deleting",
  "deleted",
];
const projectExpiries = ["none", "past", "equal", "future"];
const sessionPrincipals = [
  "missing",
  "provisional",
  "active",
  "suspended",
  "closed",
];
const approvalKinds = [
  "device_authorization",
  "pairing",
  "claim",
  "grant_claim",
  "authorization_request",
  "transaction_authorization",
];
const approvalStates = [
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
];
const digestCases = ["absent", "empty", "a", "b"];
const proofCases = ["empty", "a", "b", "other"];

export const matrices = {
  auth: {
    principal: {
      axes: [assurance],
      outputs: [["not_found", "provisional", "admitted"]],
    },
    session: {
      axes: [
        bits,
        bits,
        bits,
        ["past", "equal", "future"],
        bits,
        sessionPrincipals,
      ],
      outputs: [bits],
    },
    project: {
      axes: [
        bits,
        projectStates,
        projectExpiries,
        ["none", "member", "admin", "owner"],
      ],
      outputs: [["denied", "member", "admin", "owner"], bits, bits, bits],
    },
  },
  oauth: {
    legacy: { axes: [bits, bits, bits, bits, bits], outputs: [bits] },
    provenance: {
      axes: [
        ["0", "1", "2"],
        ["-", "1", "2"],
        ["-", "1", "2"],
        ["-", "1", "2"],
      ],
      outputs: [bits],
    },
    v4: {
      axes: [
        bits,
        bits,
        bits,
        ["sealed", "plaintext", "mixed", "unknown", "malformed"],
        bits,
        bits,
      ],
      outputs: [bits, bits],
    },
  },
  webauthn: {
    approval: {
      axes: [
        approvalKinds,
        approvalStates,
        ["invalid", "valid"],
        ["invalid", "past", "equal", "future"],
        digestCases,
        proofCases,
      ],
      outputs: [bits],
    },
  },
};

export const oauthSecurityNames = [
  "signed federated state integrity round-trips a signed state with its organization and upstream context",
  "signed federated state integrity seals the verifier on the wire with a fresh GCM IV per cookie",
  ...[
    "issuer",
    "state",
    "nonce",
    "kind",
    "providerId",
    "byoId",
    "orgId",
    "future field",
  ].map(
    (field) => `signed federated state integrity rejects a changed ${field}`,
  ),
  "signed federated state integrity rejects a tampered or swapped verifier seal",
  "signed federated state integrity rejects decoding with the wrong pepper",
  "signed federated state integrity fails closed on a plaintext or mixed verifier even under a valid v4 tag",
  "signed federated state integrity refuses a v3 cookie that main emitted before v4",
  "signed federated state integrity refuses v3 plaintext and legacy signatures, so their sign-ins restart",
  "signed federated state integrity derives no key and runs no slow hash before the MAC verifies",
  "signed federated state integrity keeps slow password hashing out of the pending cookie codec",
  ...["orgId", "byoId"].map(
    (field) =>
      `refuses a stripped legacy ${field} callback before trust lookup or exchange`,
  ),
  "binds OAuth2 callbacks to the same static OAuth2 provider",
  "refuses a changed trust owner at the exchange's own lookup",
];
export const approvalNames = [
  "refuses an operation whose present request digest and proof digest are empty",
  "retains digest-free approval for session-only interaction kinds",
  "contains every declared abstract case exactly once",
].map((name) => `Lean approval binding correspondence ${name}`);
