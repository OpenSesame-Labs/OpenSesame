import {
  FEATURES,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconChevronRight } from "../../components/Icons.js";
import { commitProposal, currentRoots } from "./useCapabilityChange.js";

/** Explicitly turn on Connections, then open the page the person chose. */
export function GithubSetupTileLink({
  href,
  children,
}: {
  href: string | null;
  children: (available: boolean | null) => ReactNode;
}) {
  const snapshot = useComposition();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!opening) return;
    if (href) {
      navigate(href);
      return;
    }
    const timer = window.setTimeout(() => {
      setOpening(false);
      setBusy(false);
      setNotice("Connections did not start. Try again from Features.");
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [opening, href, navigate]);

  const state = snapshot.plan?.capabilities["connectors.external"];
  const available = state
    ? state.distributed && state.permitted && state.runtimeSupported
    : null;
  async function enableAndOpen() {
    const feature = FEATURES.find((entry) => entry.id === "connections");
    if (!feature || !available || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const proposal = switchFeature(
        {
          roots: currentRoots(snapshot.selection),
          alternatives: snapshot.selection?.chosenAlternatives ?? {},
        },
        feature,
        true,
        snapshot.plan,
        capabilityPorts.CAPABILITY_CATALOG,
      );
      const failure = await commitProposal(snapshot, proposal);
      if (!mounted.current) return;
      if (failure) {
        setNotice(failure);
        setBusy(false);
      } else setOpening(true);
    } catch {
      if (!mounted.current) return;
      setNotice("Connections could not be turned on.");
      setBusy(false);
    }
  }

  if (href)
    return (
      <Link className="conn-tile__link" to={href}>
        {children(true)}
        <IconChevronRight className="conn-tile__go" size={14} />
      </Link>
    );
  if (available === false)
    return <span className="conn-tile__face">{children(false)}</span>;
  return (
    <>
      <button
        type="button"
        className="conn-tile__link"
        disabled={!available || busy}
        aria-busy={busy || undefined}
        onClick={() => void enableAndOpen()}
      >
        {children(available)}
        <IconChevronRight className="conn-tile__go" size={14} />
      </button>
      <FailureNotice
        id="github:open-setup"
        title="GitHub setup"
        message={notice}
      />
    </>
  );
}
