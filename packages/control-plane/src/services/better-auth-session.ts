import { randomBytes } from "node:crypto";
import type { ProvisionalSession } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  ProvisionalSessionEpochChangedError,
  saveProvisional,
} from "../repos/session-storage.js";
import { BetterAuthBridgeError } from "./better-auth-errors.js";

/** Session scope for an email-verified admission: identical to every other leg. */
const PROVISIONAL_ACTIONS = [
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
): Promise<string> {
  const now = ctx.clock();
  const session: ProvisionalSession = {
    id: `ps_${randomBytes(16).toString("hex")}`,
    principalId,
    quotaProfile: "anonymous",
    allowedActions: [...PROVISIONAL_ACTIONS],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  try {
    await saveProvisional(ctx.stores, session, accessToken);
  } catch (error) {
    if (error instanceof ProvisionalSessionEpochChangedError) {
      throw new BetterAuthBridgeError(
        "session_interrupted",
        "Sign-in was interrupted. Request a new sign-in link.",
      );
    }
    throw error;
  }
  return accessToken;
}
