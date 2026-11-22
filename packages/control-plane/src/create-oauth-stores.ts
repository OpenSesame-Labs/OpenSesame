import {
  type Database,
  type EventSealer,
  createPostgresClientClaimChallengeStore,
  createPostgresClientOriginStore,
  createPostgresClientRecordStore,
  createPostgresConsentStore,
  createPostgresOidcStore,
  createPostgresPairwiseStore,
} from "@opensesame/database";
import { MemoryClientRecordStore } from "@opensesame/oauth-provider";

/** Keep issuer clients, grants and replay state durable when a database exists. */
export function createOAuthStores(db: Database | undefined, sealer: EventSealer) {
  return {
    oidcStore: db ? createPostgresOidcStore(db, sealer) : undefined,
    pairwiseStore: db ? createPostgresPairwiseStore(db) : undefined,
    clientStore: db ? createPostgresClientRecordStore(db) : new MemoryClientRecordStore(),
    clientClaimChallengeStore: db ? createPostgresClientClaimChallengeStore(db) : undefined,
    clientOriginStore: db ? createPostgresClientOriginStore(db) : undefined,
    consentStore: db ? createPostgresConsentStore(db) : undefined,
  };
}
