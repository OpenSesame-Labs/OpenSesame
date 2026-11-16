import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
  setBackupTargetEnabled,
} from "@opensesame/app-core/lib/backup.js";
import { subscribeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  toggleHistoryProvider,
} from "@opensesame/app-core/lib/history-backups.js";
/**
 * Binary enable switch for a backup/recovery connector.
 *
 * A bound local backup target flips `enabled` (and queues a vault sync).
 * Otherwise the switch toggles vault-history selection for that provider.
 */
import { type MouseEvent, useEffect, useState } from "react";
import { useSettingsEpoch } from "../../lib/use-settings.js";

function historyToggleable(providerId: string): boolean {
  return (HISTORY_BACKUP_GROUPS[0]?.providerIds ?? []).includes(providerId);
}

export function canBackupEnable(providerId: string): boolean {
  return historyToggleable(providerId);
}

export function BackupEnableSwitch({
  providerId,
  displayName,
  showSetupHint = false,
}: {
  providerId: string;
  displayName: string;
  showSetupHint?: boolean;
}) {
  useSettingsEpoch();
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    let request = 0;
    const reload = () => {
      const current = ++request;
      void getBackupStatus(providerId)
        .then((status) => {
          if (!live || current !== request) return;
          const bound = status.target;
          setTarget(
            bound && backupTargetProviderId(bound) === providerId
              ? bound
              : null,
          );
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
  }, [providerId]);

  if (!historyToggleable(providerId)) return null;

  const bound = target !== null;
  const needsGithubTarget = providerId === "github" && !bound;
  const enabled = bound
    ? target.enabled
    : !needsGithubTarget && isHistorySelected(providerId);
  const label =
    bound || providerId === "github"
      ? `${displayName} backup`
      : `${displayName} vault history`;

  async function onToggle(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (busy || needsGithubTarget) return;
    if (bound) {
      const next = !target.enabled;
      setBusy(true);
      setTarget({ ...target, enabled: next });
      try {
        setTarget(await setBackupTargetEnabled(next, providerId));
      } catch {
        setTarget({ ...target, enabled: target.enabled });
      } finally {
        setBusy(false);
      }
      return;
    }
    await toggleHistoryProvider(providerId);
  }

  return (
    <>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={enabled}
        aria-busy={busy || undefined}
        disabled={busy || needsGithubTarget}
        aria-label={label}
        title={needsGithubTarget ? "Configure a repository first" : label}
        onClick={(event) => void onToggle(event)}
      />
      {showSetupHint && needsGithubTarget ? (
        <span className="conn-tile__kind">Configure a repository first</span>
      ) : null}
    </>
  );
}
