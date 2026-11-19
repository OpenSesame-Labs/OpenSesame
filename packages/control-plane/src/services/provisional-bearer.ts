import { randomBytes } from "node:crypto";
import type { ProvisionalSession } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { saveProvisional } from "../repos/session-storage.js";

const ACTIONS = [
  "project.create",
  "project.create_temporary",
  "resource.create_temporary",
  "claim.create",
  "agent.register_ephemeral",
  "session.continue_anonymous",
] as const;

/** Mint a first-party bearer for a principal that already exists. */
export async function issueProvisionalBearer(
  ctx: AppContext,
  principalId: string,
  expectedEpoch: number,
): Promise<string> {
  const now = ctx.clock();
  const session: ProvisionalSession = {
    id: `ps_${randomBytes(16).toString("hex")}`,
    principalId,
    quotaProfile: "anonymous",
    allowedActions: [...ACTIONS],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  await saveProvisional(ctx.stores, session, accessToken, expectedEpoch);
  return accessToken;
}
