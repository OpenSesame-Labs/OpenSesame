import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";

// InvocationReceipt's wire contract, shared by ordinary and frozen receipts.
const receiptOutcome = z.object({
  outcome: z.enum([
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "indeterminate",
  ]),
  // A response cannot be both a successful receipt and an error envelope.
  error: z.never().optional(),
});

// Receipt IDs are Host-generated UUIDs. Do not copy free-form upstream fields
// into model output, including when an older Host returns a legacy receipt.
const receiptId =
  /^(?:receipt:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const agentReceipt = receiptOutcome.extend({
  id: z.string().regex(receiptId).optional(),
  receipt_schema_version: z.literal(5),
});

/** Only the outcome and Host-issued evidence handle cross into agent output. */
export function projectInvocationResponse(
  httpOk: boolean,
  body: BoundaryValue,
): { outcome: string; id?: string } {
  if (!httpOk) return { outcome: "indeterminate" };
  const receipt = agentReceipt.safeParse(body);
  if (!receipt.success) return { outcome: "indeterminate" };
  const { outcome, id } = receipt.data;
  return id === undefined ? { outcome } : { outcome, id };
}
