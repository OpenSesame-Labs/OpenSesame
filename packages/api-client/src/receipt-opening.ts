const COMMITMENT = /^sha256:[0-9a-f]{64}$/u;
const OPENING = /^hmac-sha256:v1:[0-9a-f]{64}$/u;
const DOMAIN = "OpenSesame/ReceiptIntentOpening/v1\0";

/**
 * Check the private opening against a schema-6 receipt's intent commitment.
 * Verify the receipt signature separately before trusting this result. Keep the
 * opening private: its holder can test guesses of the original intent.
 */
export async function verifyReceiptIntentOpening(
  receiptCommitment: string,
  intentDigest: string,
  opening: string,
): Promise<boolean> {
  if (
    !COMMITMENT.test(receiptCommitment) ||
    !COMMITMENT.test(intentDigest) ||
    !OPENING.test(opening)
  ) {
    return false;
  }
  if (!globalThis.crypto?.subtle) throw new Error("crypto_subtle_unavailable");
  const bytes = new TextEncoder().encode(
    `${DOMAIN}${opening}\0${intentDigest}`,
  );
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return receiptCommitment === `sha256:${hex}`;
}
