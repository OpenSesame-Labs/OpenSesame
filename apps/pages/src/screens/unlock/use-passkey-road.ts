import { webauthnPrfCapabilities } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf.js";
import { useEffect, useState } from "react";

/**
 * Whether a passkey can be offered for sealing at all. The gate is PRF-scoped
 * (ADR 0180): it reads the PRF capability report, not generic WebAuthn
 * availability, so a browser that has WebAuthn but no PRF extension never
 * shows a road that can only fail at the ceremony. While the browser is still
 * probing — no capability answer yet — the road stays and the seal steps past
 * an authenticator that cannot answer (`sealUnsupported`). A host with no
 * WebAuthn at all has no PRF to offer either, so the road is not drawn.
 */
export function usePasskeyRoad(hostOk: boolean): boolean {
  const [open, setOpen] = useState<boolean | "unknown">("unknown");
  useEffect(() => {
    let live = true;
    webauthnPrfCapabilities().then(
      (report) => {
        if (live) {
          setOpen(
            report.details.publicKeyCredential &&
              report.details.extensionPrf !== false,
          );
        }
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return hostOk && open !== false;
}
