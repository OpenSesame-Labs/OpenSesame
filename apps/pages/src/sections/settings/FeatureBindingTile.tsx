/**
 * One feature-binding tile: a connector the capability family is bound to,
 * with the enable switch where the binding is a backup road. Shared by the
 * Connections settings panel and the backup modules' own panels, so the
 * tile draws the same way whichever capability owns the group.
 *
 * A tile links to its connector's page only while that page is routed
 * (`href`, ADR 0153). The GitHub tile can turn on Connections and then open
 * that same configuration page.
 */

import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
} from "@opensesame/app-core/lib/backup.js";
import { subscribeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import { hasHistorySwitch } from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  isHistorySelected,
  loadHistorySelections,
} from "@opensesame/app-core/lib/history-backups.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconChevronRight } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { BackupEnableSwitch } from "../connections/BackupEnableSwitch.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { GithubSetupTileLink } from "./GithubSetupTileLink.js";

function historyRemote(providerId: string): string | null {
  const remote = loadHistorySelections()
    .find((row) => row.providerId === providerId)
    ?.remote?.trim();
  return remote || null;
}

function targetRemote(target: BackupTargetView): string | null {
  if (target.owner && target.repo) return `${target.owner}/${target.repo}`;
  return null;
}

/**
 * The backup target saved on this device for GitHub, or null with none. Only
 * a group that can hold the backup road asks (`enabled`); the others would
 * each read the same target for a tile they do not draw.
 */
export function useBackupTarget(enabled = true): BackupTargetView | null {
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let request = 0;
    const reload = () => {
      const current = ++request;
      void getBackupStatus("github")
        .then((status) => {
          if (live && current === request) setTarget(status.target);
        })
        .catch(() => {
          if (live && current === request) setTarget(null);
        });
    };
    reload();
    const unsubscribe = subscribeLocalBackupTarget(reload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [enabled]);
  return target;
}

/** Which provider the saved target is bound to, for matching a tile. */
export function backupTargetProvider(
  target: BackupTargetView | null,
): string | null {
  return target ? backupTargetProviderId(target) : null;
}

function githubSetupHint(
  needsConnections: boolean,
  available: boolean | null,
  bound: boolean,
): string | null {
  if (!needsConnections) return bound ? null : "Configure a repository first";
  if (available === null) return "Checking Connections availability";
  return available
    ? "Turn on Connections and configure"
    : "Connections is not available on this device";
}

function FeatureBindingFace({
  provider,
  target,
  enabled,
  remote,
  setupHint,
}: {
  provider: Provider;
  target: BackupTargetView | null;
  enabled: boolean;
  remote: string | null;
  setupHint: string | null;
}) {
  return (
    <>
      <ConnectorMark
        providerId={provider.id}
        displayName={provider.displayName}
        size={32}
      />
      <span className="conn-tile__copy">
        <span className="conn-tile__name">{provider.displayName}</span>
        {remote ? <span className="conn-tile__kind">{remote}</span> : null}
        {target?.kind === "github_app" && enabled && !target.lastSyncedAt ? (
          <span className="conn-tile__kind">
            Automatic backups have not started
          </span>
        ) : null}
        {setupHint ? (
          <span className="conn-tile__kind">{setupHint}</span>
        ) : null}
      </span>
      {enabled && !remote ? (
        <StatusMark
          tone="warn"
          label="No repository yet — nothing is backed up"
        />
      ) : null}
    </>
  );
}

export function FeatureBindingTile({
  provider,
  href,
  target,
}: {
  provider: Provider;
  /** The connector's page, or null while no page is routed. */
  href: string | null;
  /** The saved backup target when this tile's provider holds it. */
  target: BackupTargetView | null;
}) {
  const bound = target !== null;
  const historyBound =
    !bound && provider.id !== "github" && hasHistorySwitch(provider.id);
  const enabled = bound
    ? target.enabled
    : historyBound && isHistorySelected(provider.id);
  const remote = bound
    ? targetRemote(target)
    : historyBound
      ? historyRemote(provider.id)
      : null;
  const showSwitch = bound || historyBound || provider.id === "github";
  const needsConnections = provider.id === "github" && href === null;

  const face = (setupHint: string | null) => (
    <FeatureBindingFace
      provider={provider}
      target={target}
      enabled={enabled}
      remote={remote}
      setupHint={setupHint}
    />
  );

  return (
    <li className={`conn-tile${enabled ? " is-on" : ""}`}>
      <div className="conn-tile__row">
        {provider.id === "github" ? (
          <GithubSetupTileLink href={href}>
            {(available) =>
              face(githubSetupHint(needsConnections, available, bound))
            }
          </GithubSetupTileLink>
        ) : href === null ? (
          <span className="conn-tile__face">{face(null)}</span>
        ) : (
          <Link className="conn-tile__link" to={href}>
            {face(null)}
            <IconChevronRight className="conn-tile__go" size={14} />
          </Link>
        )}
        {showSwitch ? (
          <BackupEnableSwitch
            providerId={provider.id}
            displayName={provider.displayName}
          />
        ) : null}
      </div>
    </li>
  );
}
