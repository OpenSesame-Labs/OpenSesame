export {
  type RootTrustAlarm,
  compareRootTrustFingerprint,
} from "./alarm.js";
export {
  PeerApprovalQueue,
  type PeerEnsureResult,
  type PeerEnsureStatus,
} from "./approval-queue.js";
export { type PeerArkSigningKey, ensurePeerArkSigningKey } from "./ark-key.js";
export {
  PEER_TRUST_ENVELOPE_KIND,
  PEER_TRUST_SIGNAL_KIND,
} from "./constants.js";
export {
  type SignedPeerTrustEnvelope,
  peerTrustSignedBytes,
  signPeerTrustEnvelope,
  verifyPeerTrustEnvelope,
} from "./envelope.js";
export {
  exportSpkiB64,
  fingerprintOfSpki,
  fingerprintOfSpkiB64,
} from "./fingerprint.js";
export {
  humanProofKindAllowsVerb,
  softwarePasskeyAllowedForVerb,
  verbRequiresHardwarePasskey,
} from "./human-proof-tier.js";
export {
  type PeerTrustRecord,
  nextEnrollmentEpoch,
  parsePeerTrustRecord,
} from "./record.js";
export { sasFromFingerprint } from "./sas.js";
export {
  type PeerTrustSignal,
  buildPeerTrustSignal,
  decodePeerTrustSignal,
  encodePeerTrustSignal,
  verifyPeerTrustSignal,
} from "./signaling.js";
export {
  type PeerTrustCommitResult,
  type PeerTrustLoadResult,
  commitPeerTrustEnrollment,
  loadPeerTrustStore,
} from "./store.js";
