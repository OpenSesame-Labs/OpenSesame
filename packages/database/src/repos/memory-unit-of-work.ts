/**
 * The in-memory unit of work behind `MemoryRepositories.transaction`, and
 * the store it commits into.
 *
 * A unit-of-work write is deferred to `commit()`, so anything a call-time
 * check cannot see (a concurrent transaction that commits first) is claimed
 * here and rechecked at commit, before any deferred write applies.
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalActivation,
  ApprovalReceipt,
  AuditEvent,
  AuthorizationRequest,
  BetterAuthSubject,
  ByoUpstream,
  CallbackReplayRecord,
  ClaimItem,
  ClaimSession,
  ComparisonChallenge,
  ExternalChannelBinding,
  ExternalIdentity,
  Interaction,
  NotificationDelivery,
  NotificationPreferences,
  OutboxEvent,
  Principal,
  WebhookDelivery,
  WebhookEndpoint,
} from "@opensesame/os-domain";
import {
  type ChannelBindingChallenge,
  ConflictError,
  type NewOutboxEvent,
  type PushSubscription,
  type UnitOfWork,
} from "./interfaces.js";

type PendingOp = () => void;

export class MemoryUnitOfWork implements UnitOfWork {
  readonly ops: PendingOp[] = [];
  readonly outboxBuffer: OutboxEvent[] = [];
  private readonly webhookAdmissions = new Map<string, number>();
  private readonly admissionChecks: PendingOp[] = [];
  private readonly commitChecks: PendingOp[] = [];
  private readonly identityClaims = new Map<string, string>();
  private readonly identityIdClaims = new Set<string>();
  private readonly identityReleases = new Set<string>();
  private readonly principalClaims = new Set<string>();
  private readonly principalReleases = new Set<string>();

  reserveWebhookEndpoint(
    principalId: string,
    check: (pending: number) => void,
  ): void {
    const pending = (this.webhookAdmissions.get(principalId) ?? 0) + 1;
    check(pending);
    this.webhookAdmissions.set(principalId, pending);
    this.admissionChecks.push(() => check(pending));
  }

  /**
   * Claim an identity tuple (and row id) for a deferred insert. The
   * call-time store check cannot see a concurrent transaction, so the
   * claim registers a check that `commit()` runs BEFORE applying any
   * write: a losing transaction rejects whole instead of stranding its
   * earlier writes when the conflict surfaces mid-commit. This is the
   * memory twin of the Postgres unique index.
   */
  claimIdentity(key: string, id: string): void {
    if (this.identityClaims.has(key) || this.identityIdClaims.has(id)) {
      throw new ConflictError(
        "external identity collision for kind+issuer+tenant+subject",
      );
    }
    this.identityClaims.set(key, id);
    this.identityIdClaims.add(id);
    this.commitChecks.push(() => {
      const occupant = this.store.identityKeys.get(key);
      if (
        occupant !== undefined &&
        occupant !== id &&
        !this.identityReleases.has(occupant)
      ) {
        throw new ConflictError(
          "external identity collision for kind+issuer+tenant+subject",
        );
      }
      if (this.store.identities.has(id) && !this.identityReleases.has(id)) {
        throw new ConflictError(
          "external identity collision for kind+issuer+tenant+subject",
        );
      }
    });
  }

  /** Note that this transaction deletes identity `id` when it commits. */
  releaseIdentity(id: string): void {
    this.identityReleases.add(id);
  }

  identityReleased(id: string): boolean {
    return this.identityReleases.has(id);
  }

  /** The principal-id twin of `claimIdentity`. */
  claimPrincipal(id: string): void {
    if (this.principalClaims.has(id)) {
      throw new ConflictError(`principal already exists: ${id}`);
    }
    this.principalClaims.add(id);
    this.commitChecks.push(() => {
      if (this.store.principals.has(id) && !this.principalReleases.has(id)) {
        throw new ConflictError(`principal already exists: ${id}`);
      }
    });
  }

  releasePrincipal(id: string): void {
    this.principalReleases.add(id);
  }

  principalReleased(id: string): boolean {
    return this.principalReleases.has(id);
  }

  constructor(private readonly store: MemoryStore) {}

  async appendOutbox(event: NewOutboxEvent): Promise<OutboxEvent> {
    const row: OutboxEvent = {
      id: event.id || randomUUID(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.payload },
      createdAt: new Date(),
      availableAt: event.availableAt ?? new Date(),
      attempts: 0,
    };
    this.outboxBuffer.push(row);
    this.ops.push(() => {
      this.store.outbox.set(row.id, { ...row, payload: { ...row.payload } });
    });
    return row;
  }

  defer(op: PendingOp): void {
    this.ops.push(op);
  }

  commit(): void {
    for (const check of this.admissionChecks) check();
    for (const check of this.commitChecks) check();
    for (const op of this.ops) {
      op();
    }
  }
}

export class MemoryStore {
  principals = new Map<string, Principal>();
  identities = new Map<string, ExternalIdentity>();
  byoUpstreams = new Map<string, ByoUpstream>();
  identityKeys = new Map<string, string>();
  betterAuth = new Map<string, BetterAuthSubject>();
  claims = new Map<string, ClaimSession>();
  claimItems = new Map<string, ClaimItem>();
  audit = new Map<string, AuditEvent>();
  outbox = new Map<string, OutboxEvent>();
  authorizationRequests = new Map<string, AuthorizationRequest>();
  interactions = new Map<string, Interaction>();
  webhookEndpoints = new Map<string, WebhookEndpoint>();
  webhookDeliveries = new Map<string, WebhookDelivery>();
  channelBindings = new Map<string, ExternalChannelBinding>();
  channelBindingChallenges = new Map<string, ChannelBindingChallenge>();
  /** Keyed by principal: one preference row per person, as the PK says. */
  notificationPreferences = new Map<string, NotificationPreferences>();
  notificationDeliveries = new Map<string, NotificationDelivery>();
  approvalActivations = new Map<string, ApprovalActivation>();
  /**
   * Keyed by `authReqId`, which is the column Postgres holds unique. Keying by
   * the id and indexing the request separately would let the two disagree; a
   * Map keyed by the unique column cannot.
   */
  comparisonChallenges = new Map<string, ComparisonChallenge>();
  /** Keyed by `authReqId` — one decision per request; see comparisonChallenges. */
  approvalReceipts = new Map<string, ApprovalReceipt>();
  callbackReplays = new Map<string, CallbackReplayRecord>();
  pushSubscriptions = new Map<string, PushSubscription>();
}

export function applyNowOrDefer(
  uow: UnitOfWork | undefined,
  apply: () => void,
) {
  if (uow instanceof MemoryUnitOfWork) {
    uow.defer(apply);
  } else {
    apply();
  }
}
