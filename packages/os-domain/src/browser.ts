/**
 * Browser-safe surface. The Node HMAC/digest helpers stay on the main entry
 * (`index.ts`) so Pages/PWA/extension never pull `node:crypto`.
 */

// An Identity-account factor as its owner sees it (ADR 0140 D10).
export * from "./account-factors.js";
export {
  type AuthorityGrant,
  type AuthorityGrantConstraints,
  resourcesAttenuate,
  validateAuthorityGrantAttenuation,
} from "./authority-grant.js";
export * from "./authorization-details.js";
// ArrayBuffer-backed copies for Web Crypto, fetch, and WebAuthn. Pure DOM.
export * from "./buffer-source.js";
export * from "./canonical-origin.js";
export {
  canonicalize,
  digestManifest,
  sha256Hex,
} from "./crypto/digest-browser.js";
export * from "./endpoint-display.js";
export * from "./endpoints.js";
export * from "./errors.js";
export * from "./fnv1a.js";
export * from "./interaction.js";
export * from "./interaction-links.js";
export * from "./invariants.js";
export * from "./json.js";
export * from "./machines/agent-registration.js";
export * from "./machines/authorization-request.js";
export * from "./machines/claim.js";
export * from "./machines/device-auth.js";
export * as interactionMachine from "./machines/interaction.js";
export * from "./machines/provisional-resource.js";
// Channel capability is one closed record (ADR 0084), and the browser reads
// it too: a settings screen and an approval review name channels with it.
export * from "./notifications.js";
// Published vault address owner/slug (ADR 0181). A pure parser, no I/O.
export * from "./org-vault-ref.js";
// Resource selectors and the authority grant with its attenuation rules are
// pure. Model keys (ADR 0192) narrow a grant in the browser with exactly the
// functions every other plane uses, so they ride on this entry too.
export {
  type ResourceScope,
  parseResourceScope,
  scopeContains,
  scopeMatches,
} from "./permission-scope.js";
// The browser-local approval path seals its own proof (ADR 0086 §7); the
// constructor is pure, so only it and its types ride on this entry.
export {
  type SealedApprovalProof,
  type ServerEstablishedApproval,
  sealApprovalProof,
} from "./proofs/approval-seal.js";
export * from "./transport-security/index.js";
export * from "./trust.js";
export * from "./types.js";
