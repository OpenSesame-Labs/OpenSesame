const MAX_ATTESTATION_BYTES = 4096;

type ExpectedWithdrawal = {
  withdrawalId: string;
  membershipIncarnation: string;
  authorityRevision: string;
};

async function boundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    /^\d+$/u.test(declared) &&
    Number(declared) > MAX_ATTESTATION_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("Host withdrawal attestation too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ATTESTATION_BYTES) {
        await reader.cancel();
        throw new Error("Host withdrawal attestation too large");
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function confirmsDurableWithdrawal(
  response: Response,
  expected: ExpectedWithdrawal,
): Promise<boolean> {
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const parsed: unknown = JSON.parse(await boundedBody(response));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const attestation = parsed as Record<string, unknown>;
  return (
    attestation.durable === true &&
    attestation.withdrawal_id === expected.withdrawalId &&
    attestation.membership_incarnation === expected.membershipIncarnation &&
    attestation.authority_revision === expected.authorityRevision
  );
}
