export type BetterAuthBridgeErrorCode =
  /** The verification did not carry an address asserted as verified. */
  | "unverified_email"
  /** The mapped principal is gone, suspended, or otherwise not signing in. */
  | "principal_unavailable"
  /** The address is already bound to a different principal by tuple. */
  | "identity_collision"
  /** The deployment is at its provisional-principal ceiling. */
  | "provisional_capacity"
  /** The per-address mint budget refused. */
  | "rate_limited"
  /** Session state changed while this single-use link was being completed. */
  | "session_interrupted";

export class BetterAuthBridgeError extends Error {
  override readonly name = "BetterAuthBridgeError";
  readonly code: BetterAuthBridgeErrorCode;

  constructor(code: BetterAuthBridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Both magic-link endpoints return the same actionable refusal. */
export function betterAuthBridgeStatus(
  code: BetterAuthBridgeErrorCode,
): 403 | 409 | 429 {
  if (code === "session_interrupted") return 409;
  return code === "rate_limited" || code === "provisional_capacity" ? 429 : 403;
}
