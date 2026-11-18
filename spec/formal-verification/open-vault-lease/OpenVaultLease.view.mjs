/** Reader labels for the open-vault lease chart. */

export const state = (v) => {
  if (v.exclusiveOk) return "destroy allowed";
  if (v.lockHeld > 0) {
    if (v.count === 0) {
      return `${v.lockHeld} lock(s) still held after release`;
    }
    return `${v.count} tab(s) open, ${v.lockHeld} lock(s) held`;
  }
  if (v.count > 0 && v.releasing > 0) {
    return `${v.live + v.releasing} tab(s) open, ${v.releasing} releasing`;
  }
  if (v.count > 0) return `${v.count} tab(s) hold the vault open`;
  return "no open lease";
};

export const step = (action) => {
  if (action === "Acquire") return "a tab opens the vault";
  if (action === "BeginReleaseCurrent") return "a tab starts releasing";
  if (action === "CompleteReleaseCurrent") return "the release finishes";
  if (action === "ReleaseStale") return "an old tab's release (ignored)";
  if (action === "ForgetLeases") return "tests forget every lease";
  if (action === "TryExclusiveDestroy") return "destroy is allowed";
  if (action === "AfterForgetAcquire") return "a new tab opens after forget";
  return action;
};
