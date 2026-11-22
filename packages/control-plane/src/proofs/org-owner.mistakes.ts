/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Every `@ts-expect-error` below is a way to skip or misuse the owner check.
 * `tsc` fails the build if one of them starts to compile, so a change to
 * `Named`, `OrgOwner` or a guarded function that weakens the guarantee shows up
 * here before it reaches a route. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { actorId, organizationId } from "../lib/ids.js";
import { putGroupRoleMapping } from "../routes/scim-groups.js";
import {
  mintScimToken,
  prepareOwnerRemovalWithdrawal,
  putLdapConfig,
  removeLdapConfig,
  removeOrganizationMembership,
  revokeScimToken,
  writeOrganizationMembership,
} from "../services/org-admin.js";
import { activeOrgOwner, orgOwner } from "./org-owner.js";

export async function orgOwnerMistakes(
  ctx: AppContext,
  config: Parameters<typeof putLdapConfig>[3],
  membership: Parameters<typeof writeOrganizationMembership>[3],
): Promise<void> {
  await name(
    actorId("prn_1"),
    organizationId("org:a"),
    organizationId("org:b"),
    async (actor, orgA, orgB) => {
      const verdict = await orgOwner(ctx.stores, actor, orgA, "not_deleted");
      if (!verdict.ok) return;

      // The honest path compiles: proof about `orgA`, call about `orgA`.
      await removeLdapConfig(ctx, orgA, verdict.proof);

      // @ts-expect-error — a proof about organization A does not authorize B.
      await removeLdapConfig(ctx, orgB, verdict.proof);

      // @ts-expect-error — no proof at all.
      await removeLdapConfig(ctx, orgA);

      // @ts-expect-error — a raw id string is not a named organization.
      await removeLdapConfig(ctx, "org:a", verdict.proof);

      // @ts-expect-error — the verdict is not the proof; the refusal case must be handled first.
      await putLdapConfig(ctx, orgA, verdict, config);

      // @ts-expect-error — a user id is not an organization id.
      await orgOwner(ctx.stores, actor, actor, "not_deleted");

      // A repair proof does not establish that an organization is active.
      // @ts-expect-error — active owner proof required for membership writes.
      await writeOrganizationMembership(ctx, orgA, verdict.proof, membership);
      // @ts-expect-error — active owner proof required for membership removal.
      await removeOrganizationMembership(ctx, orgA, verdict.proof, "prn_1");
      await putGroupRoleMapping(
        ctx,
        actor,
        orgA,
        // @ts-expect-error — active owner proof required for role mappings.
        verdict.proof,
        "group",
        "owner",
      );
      // @ts-expect-error — active owner proof required for SCIM token minting.
      await mintScimToken(ctx, orgA, verdict.proof, "hash");
      // @ts-expect-error — active owner proof required for SCIM token revocation.
      await revokeScimToken(ctx, orgA, verdict.proof, "token");

      const active = await activeOrgOwner(ctx.stores, actor, orgA);
      if (!active.ok) return;
      await writeOrganizationMembership(ctx, orgA, active.proof, membership);
      // @ts-expect-error — an active owner proof about A does not authorize B.
      await writeOrganizationMembership(ctx, orgB, active.proof, membership);

      const revocation = {
        principalId: "prn_member",
        actorPrincipalId: actor.value,
        actorType: "human" as const,
        correlationId: "type-regression",
        reason: "organization_owner_removed" as const,
      };
      await prepareOwnerRemovalWithdrawal(ctx, orgA, active.proof, revocation);

      // @ts-expect-error — a repair owner proof cannot withdraw membership.
      await prepareOwnerRemovalWithdrawal(ctx, orgA, verdict.proof, revocation);

      // @ts-expect-error — owner removal cannot compile without the owner proof.
      await prepareOwnerRemovalWithdrawal(ctx, orgA, revocation);

      await prepareOwnerRemovalWithdrawal(
        ctx,
        // @ts-expect-error — a proof about organization A cannot remove from B.
        orgB,
        active.proof,
        revocation,
      );
    },
  );

  // @ts-expect-error — a name cannot leave the callback it was created in.
  await name(actorId("prn_1"), organizationId("org:a"), (_actor, orgA) => orgA);
}
