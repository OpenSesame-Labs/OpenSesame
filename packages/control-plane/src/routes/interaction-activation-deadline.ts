import type { ApprovalActivation, Interaction } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";
import { activationDeadlineError } from "../services/interaction-clock.js";

/** Preserve the interaction route's expiry codes at the sampled time. */
export function activationDeadlineRefusal(
  c: Context<{ Variables: Variables }>,
  row: Pick<Interaction, "expiresAt">,
  activation: Pick<ApprovalActivation, "expiresAt">,
  now: Date,
): Response | undefined {
  const error = activationDeadlineError(
    row.expiresAt,
    activation.expiresAt,
    now,
  );
  return error ? c.json({ error }, 410) : undefined;
}
