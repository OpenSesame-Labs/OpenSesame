/** Reader labels for the open-vault lease chart. */

export const state = (v) => {
  if (v.count > 0) return `${v.live} tab(s) hold the vault open`;
  return "no open lease";
};

export const step = (action) => {
  if (action === "Acquire") return "a tab opens the vault";
  if (action === "ReleaseCurrent") return "that tab locks or navigates away";
  if (action === "ReleaseStale") return "an old tab's release (ignored)";
  if (action === "ForgetLeases") return "tests forget every lease";
  if (action === "TryExclusiveDestroy") return "destroy is allowed";
  if (action === "HandOffReleasePrevious") return "hand-off releases prior lease";
  return action;
};