/**
 * The Share key beside the vault's name, next to the lock (ADR 0150 as
 * amended): the one press that opens the share sheet, where a live
 * session starts. Drawn by the shell prompt's seat while Live sessions
 * is on; a guest, who is in someone else's session, gets no key.
 *
 * While this tab is hosting, the key carries a live mark and its name
 * says so; pressing it opens the session rather than starting another.
 */

import { subscribeContributions } from "@opensesame/app-core/lib/contributions.js";
import { isGuestSessionTomb } from "@opensesame/app-core/lib/duress/store/decoy-scratch.js";
import { isKnownGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
import { useCallback, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { IconShare } from "../../components/Icons.js";
import { useVaultShare } from "../../components/vault-share-seat.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { useLiveGuest, useLiveHost } from "./live-hooks.js";
import "./live.css";

const target = "shell.share";
const isDeclared = () => isKnownGuideTarget(target);

function useLiveShareGuideTarget(): (node: HTMLButtonElement | null) => void {
  const declared = useSyncExternalStore(
    subscribeContributions,
    isDeclared,
    isDeclared,
  );
  const bind = useGuideTarget<HTMLButtonElement>(target);
  return useCallback(
    (node) => bind(node && declared && isDeclared() ? node : null),
    [bind, declared],
  );
}

export function LiveShareButton() {
  const share = useVaultShare();
  const { status, guest, tomb } = useVault();
  const { host, state } = useLiveHost();
  const joined = useLiveGuest();
  const navigate = useNavigate();
  const ref = useLiveShareGuideTarget();
  if (!share) return null;
  // A joined guest still needs one key back to the live catalog after moving
  // around the vault; the Share sheet is the owner's, not theirs.
  if (
    joined.guest &&
    joined.status &&
    joined.status.at !== "ended" &&
    joined.status.at !== "unreachable"
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className="icon-btn live-share live-share--on"
        onClick={() => navigate("/live")}
        aria-label="Open live session"
        aria-controls="live-view"
        title="Open live session"
      >
        <IconShare size={18} />
      </button>
    );
  }
  if (status !== "unlocked" || guest || isGuestSessionTomb(tomb ?? null)) {
    return null;
  }
  const live = Boolean(host && state?.status === "live");
  const label = live ? "Sharing — live session" : "Share this vault";
  return (
    <button
      ref={ref}
      type="button"
      className={
        live ? "icon-btn live-share live-share--on" : "icon-btn live-share"
      }
      onClick={() => share.open()}
      aria-label={label}
      title={label}
    >
      <IconShare size={18} />
    </button>
  );
}
