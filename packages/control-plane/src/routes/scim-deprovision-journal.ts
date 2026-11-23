import type { ScimUserRecord } from "@opensesame/database";
import { z } from "zod";

export const SCIM_DEPROVISION_JOURNAL_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-journal";

const orphanSchema = z.object({
  authorityRevision: z.string().min(1),
  withdrawalId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)),
});
const targetSchema = z.object({
  principalId: z.string().min(1),
  incarnation: z.string().min(1),
  completed: z.boolean(),
  legacyOrphan: orphanSchema.optional(),
});
const journalSchema = z.object({
  cycle: z.string().min(1),
  targets: z.array(targetSchema),
});

export type LegacyOrphan = z.infer<typeof orphanSchema>;
export type DeprovisionTarget = z.infer<typeof targetSchema>;
export type DeprovisionJournal = z.infer<typeof journalSchema>;

/** A malformed journal must never be guessed or overwritten as legacy data. */
export function deprovisionJournal(
  user: ScimUserRecord,
): DeprovisionJournal | undefined {
  const parsed = journalSchema.safeParse(
    user.raw[SCIM_DEPROVISION_JOURNAL_ATTRIBUTE],
  );
  return parsed.success ? parsed.data : undefined;
}
