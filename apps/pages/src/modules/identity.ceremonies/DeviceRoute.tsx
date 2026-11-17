/**
 * `/device` (ADR 0140 plan step 7): approve a device or CLI sign-in from the
 * link it printed. The code arrives as `?user_code=` — or in one of the
 * older shapes `bootCore` normalised to it — and left the address before the
 * first paint (`app-core/lib/device-link.ts`); this screen takes it from
 * there and asks the person to confirm it against the device.
 *
 * The approval itself is Identity › Devices' form (`DeviceApproval`), not a
 * second copy. It needs a signed-in Identity session, never a vault (ADR 0140
 * §2): the route opens before unlock, on a locked or empty device too, and
 * without a session it offers sign-in, and without an Identity API it shows
 * how to connect one. A refusal is the mark beside the code.
 */

import { env } from "@opensesame/app-core/host.js";
import {
  DEVICE_LINK_REFUSED,
  type DeviceApprovalResult,
  reportRefusedDeviceLink,
} from "@opensesame/app-core/lib/device-approval.js";
import {
  captureDeviceLinkFromPage,
  devicePath,
  peekDeviceArrival,
  takeDeviceArrival,
} from "@opensesame/app-core/lib/device-link.js";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useIdentitySession } from "../../bindings/identity.js";
import { firstControl, landFocus } from "../../lib/focus.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useOnline } from "../../lib/use-online.js";
import { SignInPanel } from "../../screens/unlock/SignInPanel.js";
import { useFederatedProviders } from "../../screens/unlock/use-federated-providers.js";
import { ConnectIdentityNote } from "../../sections/identity/ConnectIdentityNote.js";
import { DeviceApproval } from "../../sections/identity/DeviceApproval.js";
import "../../screens/unlock.css";

const REFUSED: DeviceApprovalResult = {
  tone: "err",
  words: DEVICE_LINK_REFUSED,
};

export function DeviceRoute() {
  const online = useOnline();
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const location = useLocation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement | null>(null);
  const ready = configured && session !== null;
  // An in-app navigation to `/device?user_code=…` never passed through boot:
  // read it here, the same way. The code stays waiting in the core until it
  // is approved, so the route coming back — connecting a session re-resolves
  // the plan and remounts it — still shows it; a refusal is said once.
  const [arrival] = useState(() => {
    captureDeviceLinkFromPage();
    return peekDeviceArrival();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (arrival.kind === "refused") {
      takeDeviceArrival();
      reportRefusedDeviceLink();
    }
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, []);

  // With a session, the approval form places focus itself.
  useEffect(() => {
    if (!ready) landFocus(firstControl(root.current));
  }, [ready]);

  const arrivedCode = arrival.kind === "code" ? arrival.userCode : null;
  return (
    <div className="section__inner" ref={root}>
      <div className="section__head">
        <h1>Approve a device</h1>
      </div>
      {ready ? (
        <section className="panel" aria-label="Device sign-in">
          <div className="panel__body">
            <DeviceApproval
              key={`${session?.issuerOrigin}:${session?.principalId}`}
              online={online}
              arrivedCode={arrivedCode}
              initialResult={arrival.kind === "refused" ? REFUSED : null}
            />
          </div>
        </section>
      ) : configured ? (
        <DeviceSignIn arrivalCode={arrivedCode} />
      ) : (
        <ConnectIdentityNote
          online={online}
          what="the devices that sign in"
          lockIssuer
        />
      )}
    </div>
  );
}

function DeviceSignIn({ arrivalCode }: { arrivalCode: string | null }) {
  const providers = useFederatedProviders();
  const path = devicePath(env().BASE_URL || "/");
  const query = arrivalCode
    ? `?${new URLSearchParams({ user_code: arrivalCode })}`
    : "";
  return (
    <section className="panel" aria-label="Sign in to approve a device">
      <div className="panel__head">
        <h2>Sign in to approve this device</h2>
      </div>
      <div className="panel__body">
        <SignInPanel
          placement="secondary"
          providers={providers}
          returnTo="/device"
          magicLinkReturnTo={`${path}${query}`}
        />
      </div>
    </section>
  );
}
