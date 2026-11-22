import { ConflictError, type ScimUserRecord } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  deprovision,
  deprovisionJournal,
  prepareDeprovision,
  withRememberedSubjects,
} from "./scim-effects.js";

export type UserPatch = {
  active?: boolean;
  userName?: string;
  displayName?: string;
  externalId?: string;
};

type MutationResult =
  | { error: "not_found" | "conflict" }
  | { user: ScimUserRecord; updated: ScimUserRecord };

export async function patchScimUser(
  ctx: AppContext,
  organization: Organization,
  userId: string,
  patch: UserPatch,
  correlationId: string,
): Promise<MutationResult> {
  while (true) {
    let outcome: MutationResult | { resume: ScimUserRecord };
    try {
      outcome = await withScimOrganizationBoundary(ctx, organization.id, (tx) =>
        prepareUserPatch(tx, organization, userId, patch, correlationId),
      );
    } catch (error) {
      if (error instanceof ConflictError) outcome = { error: "conflict" };
      else throw error;
    }
    if ("error" in outcome) return outcome;
    if ("resume" in outcome) {
      await deprovision(ctx, organization, outcome.resume, correlationId);
      continue;
    }
    if (!outcome.updated.active)
      await deprovision(ctx, organization, outcome.updated, correlationId);
    return outcome;
  }
}

async function prepareUserPatch(
  tx: AppContext,
  organization: Organization,
  userId: string,
  patch: UserPatch,
  correlationId: string,
): Promise<MutationResult | { resume: ScimUserRecord }> {
  const current = await tx.stores.scim.users.getVersioned(
    organization.id,
    userId,
  );
  if (!current) return { error: "not_found" as const };
  const user = current.user;
  if (!user.active && !deprovisionJournal(user)) {
    const recovered = await prepareDeprovision(
      tx,
      organization,
      user,
      correlationId,
    );
    const replaced = await tx.stores.scim.users.replaceIfRevision(
      organization.id,
      userId,
      current.revision,
      recovered,
    );
    if (!replaced) throw new Error("SCIM user changed concurrently");
    return { resume: replaced.user };
  }
  const inactive = inactivePatchDisposition(user, patch);
  if (inactive === "resume") return { resume: user };
  if (patch.userName && patch.userName !== user.userName) {
    const clash = await tx.stores.scim.users.findByUserName(
      organization.id,
      patch.userName,
    );
    if (clash && clash.id !== user.id) return { error: "conflict" as const };
  }
  let next = nextUser(user, patch, tx.clock());
  // An explicit re-deactivation of an already-inactive row rebuilds the
  // journal: a retry whose membership rows are already gone must still
  // advance the publication fence instead of silently no-op'ing.
  if (patch.active === false && !next.active)
    next = await prepareDeprovision(tx, organization, next, correlationId);
  const replaced = await tx.stores.scim.users.replaceIfRevision(
    organization.id,
    userId,
    current.revision,
    next,
  );
  if (!replaced) throw new Error("SCIM user changed concurrently");
  return { user, updated: replaced.user };
}

function inactivePatchDisposition(
  user: ScimUserRecord,
  patch: UserPatch,
): "resume" | undefined {
  if (user.active) return undefined;
  const journal = deprovisionJournal(user);
  if (patch.active === true)
    return journal?.targets.some((target) => !target.completed)
      ? "resume"
      : undefined;
  return undefined;
}

function nextUser(
  user: ScimUserRecord,
  patch: UserPatch,
  updatedAt: Date,
): ScimUserRecord {
  const next: ScimUserRecord = {
    ...user,
    userName: patch.userName ?? user.userName,
    active: patch.active ?? user.active,
    updatedAt,
  };
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  if (patch.externalId !== undefined) next.externalId = patch.externalId;
  return withRememberedSubjects(user, next);
}

export async function deleteScimUser(
  ctx: AppContext,
  organization: Organization,
  userId: string,
  correlationId: string,
): Promise<MutationResult> {
  const outcome = await withScimOrganizationBoundary(
    ctx,
    organization.id,
    async (tx) => {
      const current = await tx.stores.scim.users.getVersioned(
        organization.id,
        userId,
      );
      if (!current) return { error: "not_found" as const };
      const user = current.user;
      if (!user.active) {
        if (deprovisionJournal(user)) return { user, updated: user };
        const recovered = await prepareDeprovision(
          tx,
          organization,
          user,
          correlationId,
        );
        const replaced = await tx.stores.scim.users.replaceIfRevision(
          organization.id,
          userId,
          current.revision,
          recovered,
        );
        if (!replaced) throw new Error("SCIM user changed concurrently");
        return { user, updated: replaced.user };
      }
      const next = await prepareDeprovision(
        tx,
        organization,
        {
          ...user,
          active: false,
          updatedAt: ctx.clock(),
        },
        correlationId,
      );
      const replaced = await tx.stores.scim.users.replaceIfRevision(
        organization.id,
        userId,
        current.revision,
        next,
      );
      if (!replaced) throw new Error("SCIM user changed concurrently");
      return { user, updated: replaced.user };
    },
  );
  if (!("error" in outcome))
    await deprovision(ctx, organization, outcome.updated, correlationId);
  return outcome;
}
