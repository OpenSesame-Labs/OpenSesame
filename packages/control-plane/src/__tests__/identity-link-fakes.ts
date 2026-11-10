import type { UnitOfWork } from "@opensesame/database";
import type {
  AuditEvent,
  ExternalIdentity,
  Principal,
} from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** In-memory repositories for the identity-link unit suites. */

/** The fakes ignore the unit of work: every write lands immediately. */
const NO_UNIT_OF_WORK: UnitOfWork = overlapCast({});

export const NOW = new Date("2026-08-22T12:00:00.000Z");

export type Fakes = {
  ctx: AppContext;
  identities: ExternalIdentity[];
  principals: Map<string, Principal>;
  audits: { eventType: string; outcome: string }[];
  auditEvents: AuditEvent[];
  created: ExternalIdentity[];
  updates: { id: string; patch: PrincipalPatch }[];
  createImpl: (identity: ExternalIdentity) => Promise<ExternalIdentity>;
};

/**
 * The verified-email index, resolved exactly as `ExternalIdentityRepository`
 * does (`packages/database`): only rows whose assurance is `verified` and
 * whose `emailVerified` is not explicitly false are candidates, and when
 * several match, the oldest owning principal wins with the principal id as the
 * tie-break. `email_normalized` is deliberately non-unique in the schema, so
 * that ordering is the contract rather than an accident of insertion (T32).
 */
function verifiedEmailOwner(
  state: Fakes,
  emailNormalized: string,
): ExternalIdentity | null {
  const candidates = state.identities
    .filter(
      (e) =>
        e.emailNormalized === emailNormalized &&
        e.assurance === "verified" &&
        e.emailVerified !== false,
    )
    .flatMap((row) => {
      const owner = state.principals.get(row.principalId);
      return owner ? [{ row, owner }] : [];
    })
    .sort((a, b) => {
      const byAge = a.owner.createdAt.getTime() - b.owner.createdAt.getTime();
      if (byAge !== 0) return byAge;
      return a.owner.id.localeCompare(b.owner.id);
    });
  return candidates[0]?.row ?? null;
}

export type PrincipalPatch = Parameters<
  AppContext["repos"]["principals"]["update"]
>[1];

export function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "prn_1",
    state: "provisional",
    assurance: "provisional",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

export function identity(
  overrides: Partial<ExternalIdentity> = {},
): ExternalIdentity {
  return {
    id: "xid_existing",
    principalId: "prn_1",
    kind: "oidc",
    issuer: "https://shoo.dev",
    subject: "sub-1",
    assurance: "verified",
    linkedAt: NOW,
    metadata: {},
    ...overrides,
  };
}

export function makeFakes(): Fakes {
  const state: Fakes = {
    identities: [],
    principals: new Map([["prn_1", principal()]]),
    audits: [],
    auditEvents: [],
    created: [],
    updates: [],
    createImpl: async (record) => record,
    ctx: overlapCast({}),
  };

  state.ctx = overlapCast({
    clock: () => NOW,
    repos: {
      externalIdentities: {
        // Honours `kind` as the real repository does: the unique index is
        // (kind, issuer, tenant, subject), so a lookup that ignored the kind
        // would let an OIDC identity collide with a non-OIDC one that happens
        // to share an issuer and subject.
        findByTuple: async (q: {
          kind: string;
          issuer: string;
          subject: string;
        }) =>
          state.identities.find(
            (e) =>
              e.kind === q.kind &&
              e.issuer === q.issuer &&
              e.subject === q.subject,
          ) ?? null,
        listByEmailNormalized: async (email: string) =>
          state.identities.filter((e) => e.emailNormalized === email),
        findVerifiedByEmail: async (email: string) =>
          verifiedEmailOwner(state, email),
        create: async (record: ExternalIdentity) => {
          const stored = await state.createImpl(record);
          state.created.push(stored);
          state.identities.push(stored);
          return stored;
        },
        deleteById: async (id: string) => {
          const before = state.identities.length;
          state.identities = state.identities.filter((row) => row.id !== id);
          return state.identities.length !== before;
        },
      },
      principals: {
        getById: async (id: string) => state.principals.get(id) ?? null,
        update: async (id: string, patch: PrincipalPatch, _version: number) => {
          state.updates.push({ id, patch });
          const current = state.principals.get(id);
          if (!current) return null;
          const next = { ...current, ...patch, version: current.version + 1 };
          state.principals.set(id, next);
          return next;
        },
      },
      transaction: async <T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> =>
        fn(NO_UNIT_OF_WORK),
      auditEvents: {
        append: async (event: AuditEvent) => {
          state.audits.push({
            eventType: event.eventType,
            outcome: event.outcome,
          });
          state.auditEvents.push(event);
          return event;
        },
      },
    },
  });

  return state;
}

export const INPUT = {
  issuer: "https://shoo.dev",
  subject: "sub-1",
  correlationId: "corr-1",
};
