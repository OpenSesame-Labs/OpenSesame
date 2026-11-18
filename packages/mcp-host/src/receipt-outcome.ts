import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";

// InvocationReceipt's wire contract, shared by ordinary and frozen receipts.
const receiptOutcome = z.object({
  outcome: z.enum(["succeeded", "failed", "denied", "cancelled"]),
  // A response cannot be both a successful receipt and an error envelope.
  error: z.never().optional(),
});

/** A successful HTTP exchange is not necessarily a successful invocation. */
export function invocationFailed(
  httpOk: boolean,
  body: BoundaryValue,
): boolean {
  const receipt = receiptOutcome.safeParse(body);
  return !httpOk || !receipt.success || receipt.data.outcome !== "succeeded";
}
