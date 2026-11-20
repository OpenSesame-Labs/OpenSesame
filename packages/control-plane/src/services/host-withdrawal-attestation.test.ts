import { describe, expect, it } from "vitest";
import { confirmsDurableWithdrawal } from "./host-withdrawal-attestation.js";

const expected = {
  withdrawalId: "a1af5314-ca5d-4c49-8939-2218b852d64a",
  membershipIncarnation: "3c8c682a-e764-4be8-b3d5-486c19043947",
  authorityRevision: "d5736e6e-bcb6-44c3-97f4-460d7c1333d8",
};

function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Host withdrawal attestation", () => {
  it("requires an exact durable tuple", async () => {
    await expect(
      confirmsDurableWithdrawal(response({ revoked: 1 }), expected),
    ).resolves.toBe(false);
    await expect(
      confirmsDurableWithdrawal(
        response({
          durable: true,
          withdrawal_id: expected.withdrawalId,
          membership_incarnation: expected.membershipIncarnation,
          authority_revision: `${expected.authorityRevision}-wrong`,
        }),
        expected,
      ),
    ).resolves.toBe(false);
    await expect(
      confirmsDurableWithdrawal(
        response({
          durable: true,
          withdrawal_id: expected.withdrawalId,
          membership_incarnation: expected.membershipIncarnation,
          authority_revision: expected.authorityRevision,
        }),
        expected,
      ),
    ).resolves.toBe(true);
  });

  it("bounds streamed responses without trusting content-length", async () => {
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
          controller.close();
        },
      }),
      { status: 200 },
    );
    await expect(
      confirmsDurableWithdrawal(oversized, expected),
    ).rejects.toThrow("too large");
  });
});
