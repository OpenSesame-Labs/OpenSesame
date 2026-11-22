import { ConflictError, type Repositories } from "@opensesame/database";
import type { Clock } from "@opensesame/os-domain";

/** The fixed owner of auto-admitted origin clients (ADR 0050 R-A). */
export const SYSTEM_OWNER_PRINCIPAL_ID = "prn_opensesame_system";

/** Ensure the owner exists before a client can refer to it. */
export async function ensureSystemOwnerPrincipal(
  repos: Pick<Repositories, "principals">,
  clock: Clock,
): Promise<void> {
  const existing = await repos.principals.getById(SYSTEM_OWNER_PRINCIPAL_ID);
  if (existing) return;
  const now = clock();
  try {
    await repos.principals.create({
      id: SYSTEM_OWNER_PRINCIPAL_ID,
      state: "active",
      assurance: "verified",
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
      version: 1,
    });
  } catch (error) {
    // A concurrent replica created it first — that is the desired end state.
    if (!(error instanceof ConflictError)) throw error;
  }
}
