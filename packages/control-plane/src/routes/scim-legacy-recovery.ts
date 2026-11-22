import { randomUUID } from "node:crypto";
import type { ScimUserRecord } from "@opensesame/database";
import type { Organization } from "@opensesame/os-domain";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { prepareDirectoryRemoval } from "./directory-removal.js";
import type { DeprovisionTarget } from "./scim-deprovision-journal.js";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE,
  deprovisionJournal,
  prepareDeprovision,
} from "./scim-effects.js";

/** Called inside the organization boundary. The returned row remains inactive. */
export async function prepareLegacyDeprovision(
  tx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  revision: string,
  correlationId: string,
): Promise<ScimUserRecord> {
  if (user.active) return user;
  const existing = deprovisionJournal(user);
  if (existing) {
    for (const target of existing.targets) {
      if (target.completed || target.legacyOrphan) continue;
      const current = await tx.stores.organizationMemberships.findVersioned(
        organization.id,
        target.principalId,
      );
      if (!current || current.incarnation !== target.incarnation) continue;
      const prepared = await prepareDirectoryRemoval(tx, {
        organizationId: organization.id,
        principalId: target.principalId,
        incarnation: target.incarnation,
        reason: "scim_deactivated",
        correlationId,
      });
      if (prepared.status === "ready" || prepared.status === "missing")
        continue;
      if (prepared.status === "busy" && current.withdrawal?.kind === "remove")
        continue;
      throw new Error("Could not fence pending SCIM deprovisioning");
    }
    return user;
  }
  if (Object.hasOwn(user.raw, SCIM_DEPROVISION_JOURNAL_ATTRIBUTE))
    throw new Error("Invalid SCIM deprovision journal");

  // The legacy marker was written only after the principal had a membership
  // here. Its membership may have been removed before session revocation ran.
  const marker = user.raw[SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE];
  const parsedMarker = z.array(z.string().min(1)).optional().safeParse(marker);
  if (!parsedMarker.success)
    throw new Error("Invalid legacy SCIM deprovision marker");
  const principals = [...new Set(parsedMarker.data ?? [])];
  const excluded: string[] = [];
  const orphans: DeprovisionTarget[] = [];
  let sessionsByPrincipal: Map<string, string[]> | undefined;
  const marked = new Set(principals);
  for (const principalId of principals) {
    const store = tx.stores.organizationMemberships;
    if (await store.findVersioned(organization.id, principalId)) continue;
    if (!sessionsByPrincipal) {
      sessionsByPrincipal = new Map();
      for (const session of await tx.stores.provisionalSessions.values()) {
        if (!marked.has(session.principalId)) continue;
        const ids = sessionsByPrincipal.get(session.principalId) ?? [];
        ids.push(session.id);
        sessionsByPrincipal.set(session.principalId, ids);
      }
    }
    orphans.push({
      principalId,
      incarnation: randomUUID(),
      completed: false,
      legacyOrphan: {
        authorityRevision: randomUUID(),
        withdrawalId: randomUUID(),
        sessionIds: sessionsByPrincipal.get(principalId) ?? [],
      },
    });
    // A later membership is a new incarnation and is not this old removal.
    excluded.push(principalId);
  }
  let prepared = await prepareDeprovision(
    tx,
    organization,
    user,
    correlationId,
    principals,
    excluded,
  );
  if (orphans.length) {
    const journal = deprovisionJournal(prepared);
    if (!journal) throw new Error("Could not prepare SCIM deprovision journal");
    prepared = {
      ...prepared,
      raw: {
        ...prepared.raw,
        [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: {
          cycle: journal.cycle,
          targets: [...journal.targets, ...orphans],
        },
      },
    };
  }
  const replaced = await tx.stores.scim.users.replaceIfRevision(
    organization.id,
    user.id,
    revision,
    prepared,
  );
  if (!replaced) throw new Error("SCIM user changed concurrently");
  return replaced.user;
}
