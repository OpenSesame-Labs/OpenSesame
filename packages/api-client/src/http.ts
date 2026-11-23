import type { BoundaryValue } from "@opensesame/os-domain";
import { parseLosslessJson } from "./safe-json.js";

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

/** Build the JSON half of a {@link HostRequestContext} over a raw request. */
export function jsonRequests(
  request: HostRequestContext["request"],
  requestFailure: (op: string, res: Response) => Promise<Error>,
): Pick<HostRequestContext, "requestJson" | "requestJsonLossless"> {
  async function requestJson(
    op: string,
    path: string,
    init: RequestInit = {},
  ): Promise<BoundaryValue> {
    const res = await request(path, init);
    if (!res.ok) throw await requestFailure(op, res);
    return res.json();
  }

  async function requestJsonLossless(
    op: string,
    path: string,
    init: RequestInit = {},
  ): Promise<BoundaryValue> {
    const res = await request(path, init);
    if (!res.ok) throw await requestFailure(op, res);
    return parseLosslessJson(await res.text());
  }

  return { requestJson, requestJsonLossless };
}
