import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  type ScimUserRecord,
} from "@opensesame/database";

/** One membership incarnation a SCIM deactivation must withdraw (D11). */
export type DeprovisionTarget = {
  principalId: string;
  incarnation: string;
  completed: boolean;
  legacyOrphan?: {
    authorityRevision: string;
    withdrawalId: string;
  };
};

export type DeprovisionJournal = {
  cycle: string;
  targets: DeprovisionTarget[];
};

function deprovisionTarget(value: unknown): DeprovisionTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const principalId = Reflect.get(value, "principalId");
  const incarnation = Reflect.get(value, "incarnation");
  const completed = Reflect.get(value, "completed");
  if (
    typeof principalId !== "string" ||
    typeof incarnation !== "string" ||
    typeof completed !== "boolean"
  )
    return;
  const legacy = Reflect.get(value, "legacyOrphan");
  if (legacy === undefined) return { principalId, incarnation, completed };
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return;
  const authorityRevision = Reflect.get(legacy, "authorityRevision");
  const withdrawalId = Reflect.get(legacy, "withdrawalId");
  if (typeof authorityRevision !== "string" || typeof withdrawalId !== "string")
    return;
  return {
    principalId,
    incarnation,
    completed,
    legacyOrphan: { authorityRevision, withdrawalId },
  };
}

/** Parse the persisted journal; any malformed target invalidates the whole. */
export function deprovisionJournal(
  user: ScimUserRecord,
): DeprovisionJournal | undefined {
  const value = user.raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const cycle = Reflect.get(value, "cycle");
  const targets = Reflect.get(value, "targets");
  if (typeof cycle !== "string" || !Array.isArray(targets)) return undefined;
  const parsed: DeprovisionTarget[] = [];
  for (const target of targets) {
    const value = deprovisionTarget(target);
    if (!value) return undefined;
    parsed.push(value);
  }
  return { cycle, targets: parsed };
}
