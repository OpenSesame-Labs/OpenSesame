import type { BoundaryValue } from "@opensesame/os-domain";

/**
 * The authenticated request pipeline a client instance closes over (bearer +
 * DPoP + loopback-pinned base). Resource modules receive this instead of a
 * fetch so every call shares one credential-handling path.
 */
export interface HostRequestContext {
  request(path: string, init?: RequestInit): Promise<Response>;
  requestJson(
    op: string,
    path: string,
    init?: RequestInit,
  ): Promise<BoundaryValue>;
  /**
   * Same pipeline as requestJson, but integers outside JavaScript's safe
   * range survive as bigint. Freeze/recovery payloads are signed digest
   * inputs; rounding them would corrupt the recovery proof.
   */
  requestJsonLossless(
    op: string,
    path: string,
    init?: RequestInit,
  ): Promise<BoundaryValue>;
}
