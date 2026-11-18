import {
  DomainError,
  type Interaction,
  type SealedApprovalProof,
  interactionMachine,
} from "@opensesame/os-domain";

/** Check an application sample; this is not an atomic database deadline. */
export function isLiveAt(expiresAt: Date, now: Date): boolean {
  const deadline = expiresAt.getTime();
  const sampledAt = now.getTime();
  return (
    Number.isFinite(deadline) &&
    Number.isFinite(sampledAt) &&
    sampledAt < deadline
  );
}

export function requireLiveAt(expiresAt: Date, now: Date): Date {
  if (!isLiveAt(expiresAt, now)) {
    throw new DomainError("EXPIRED", "interaction expired");
  }
  return now;
}

export function liveNow(
  ctx: { clock: () => Date },
  row: { expiresAt: Date },
): Date {
  return requireLiveAt(row.expiresAt, ctx.clock());
}

export function decideAtLiveTime(
  ctx: { clock: () => Date },
  row: Interaction,
  principalId: string,
  decision: "approved" | "denied",
  approval: { proof: SealedApprovalProof; expiresAt: Date } | undefined,
) {
  const decidedAt = liveNow(ctx, row);
  if (approval && !isLiveAt(approval.expiresAt, decidedAt)) {
    throw new DomainError("INVALID_TOKEN", "approval activation expired");
  }
  const staged =
    row.status === "awaiting_approval"
      ? row
      : interactionMachine.awaitApproval(row, principalId, decidedAt);
  const settled =
    decision === "approved" && approval
      ? interactionMachine.approve(staged, {
          approverPrincipalId: principalId,
          now: decidedAt,
          proof: approval.proof,
        })
      : interactionMachine.deny(staged, principalId, decidedAt);
  return { settled, decidedAt };
}
