import type { JsonObject } from "./json.js";
import type { AuditActorType, PrincipalId } from "./types.js";

/**
 * Bounded provisional capability bound to a proof key / browser session.
 * Distinct from ClaimSession and DeviceAuthorizationSession.
 */
export interface ProvisionalSession {
  id: string;
  principalId: PrincipalId;
  instanceKeyJkt?: string;
  /** Hash of the tab's separate proof for restoring this exact browser session. */
  restoreProofHash?: string;
  quotaProfile: string;
  allowedActions: string[];
  createdAt: Date;
  expiresAt: Date;
  claimedAt?: Date;
  revokedAt?: Date;
  /** Retry cleanup if a proof-based revoke committed before follow-up work finished. */
  revocationCleanupPending?: boolean;
  /** Durable audit context used by any replica that resumes cleanup. */
  revocationCleanup?: {
    actorType: AuditActorType;
    correlationId: string;
    metadata: JsonObject;
  };
  lastSeenAt?: Date;
}
