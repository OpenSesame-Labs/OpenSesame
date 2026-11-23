/** Physical guest vault names are reserved and never reused by a fresh guest. */
const ISOLATED_GUEST =
  /^guest_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function newGuestVaultId(): string {
  return `guest_${crypto.randomUUID()}`;
}

export function isIsolatedGuestVaultId(id: string | null): boolean {
  return id !== null && ISOLATED_GUEST.test(id);
}

/** Includes the original guest tomb so older protected vaults remain accessible. */
export function isGuestVaultId(id: string | null): boolean {
  return id === "guest" || isIsolatedGuestVaultId(id);
}
