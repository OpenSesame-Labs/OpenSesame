import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";

/** True while a walkthrough is in flight — terminal snapshots are not "running". */
export function guideSnapshotActive(
  snapshot: GuideRuntimeSnapshot | null,
): boolean {
  if (snapshot === null) return false;
  return (
    snapshot.status === "running" ||
    snapshot.status === "waiting" ||
    snapshot.status === "paused"
  );
}