import type { SiopIssuerProfile } from "@opensesame/siop-v2";

/** Server-issued SIOP link ceremony binding (ADR 0117). Single-use, short TTL. */
export interface SiopLinkChallenge {
  id: string;
  principalId: string;
  nonce: string;
  audience: string;
  profile: SiopIssuerProfile;
  expiresAt: number;
}

/** A code sent out of band and not yet verified; only its hash is held. */
export interface MfaCodeChallenge {
  principalId: string;
  channel: "email" | "sms";
  /** Where it went, verbatim — returned masked, never whole. */
  to: string;
  /** sha256(challengeId ":" code), hex. */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

/** One rolling send window: a principal's, or a destination digest's. */
export interface MfaCodeSendWindow {
  /** When each send in the window happened, epoch ms, oldest first. */
  sentAt: number[];
  expiresAt: number;
}

export type ProvisionalProofRecord = Readonly<{
  principalId: string;
  restoreProofHash: string;
}>;

export type UpstreamLogoutOperation = Readonly<{
  operationKey: string;
  issuer: string;
  subject: string;
  sessionIds: readonly string[];
  sessionsRevoked: number;
  correlationId: string;
  retainUntil: number;
  completed: boolean;
}>;

export type PrincipalSessionFence = Readonly<{
  generation: number;
  operations: readonly string[];
}>;
