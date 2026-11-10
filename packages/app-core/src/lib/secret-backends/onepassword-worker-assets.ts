import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import {
  type OnePasswordAssets,
  onePasswordNetworkError,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";
import { createGzipWasmAssetFetch } from "./wasm-gzip-asset.js";

/** Authenticate the pinned 1Password transport and raw WASM through the shared loader. */
export function createOnePasswordAssetFetch(
  assets: OnePasswordAssets,
  signal: AbortSignal,
  check: () => void,
  nativeFetch: SecretBackendFetch,
  /** The loading worker's own address, which a relative asset URL resolves against. */
  base?: string,
): SecretBackendFetch {
  return createGzipWasmAssetFetch(
    {
      url: assets.wasmUrl,
      base,
      compressed: {
        bytes: artifacts.sdk.wasmGzipBytes,
        hash: artifacts.sdk.wasmGzipHash,
      },
      raw: {
        bytes: artifacts.sdk.wasmBytes,
        hash: artifacts.sdk.wasmHash,
      },
    },
    signal,
    check,
    nativeFetch,
    onePasswordNetworkError,
  );
}
