/** Reader labels for the vault unlock chart. No TLC names on the drawing. */

export const state = (v) => {
  if (v.open && v.awaitingSecondStep) {
    return "Vault open, second step still showing";
  }
  if (v.open && v.ephemeral) return "Guest session open";
  if (v.open && v.enrolled) return "Vault open, second step on";
  if (v.open) return "Vault open";
  if (v.pending) return "Second step waiting";
  if (v.trusted) return "Circle must approve";
  if (v.header) return "Vault locked";
  return "Nothing stored";
};

export const step = (action, from, to) => {
  if (action === "CreateVault") return "you create a vault";
  if (action === "CreateGuest") return "you continue as a guest";
  if (action === "EnrollSecondStep") return "you turn on a second step";
  if (action === "RemoveSecondStep") return "you turn off the second step";
  if (action === "Lock") {
    if (!to.header) return "the guest session ends";
    if (from.open && from.pending) {
      return "cancelling the second step locks the open vault";
    }
    if (from.pending) return "the second step is cancelled";
    if (from.trusted) return "the circle approval is cancelled";
    return "the vault locks";
  }
  if (action === "PrimaryUnlock") {
    if (to.pending) return "you unlock and the vault asks for the second step";
    if (to.trusted) return "you unlock and a circle must approve";
    return "you unlock and the vault opens";
  }
  if (action === "FinishSecondStep") {
    if (to.trusted)
      return "you enter the second step and a circle must approve";
    return "you enter the second step and the vault opens";
  }
  if (action === "BuggyUnlockOpen") {
    return "the vault opens while the second step still shows";
  }
  if (action === "ConfirmTrusted") return "a trusted contact approves";
  return "the session changes";
};

export const group = (v) => {
  if (v.open && v.awaitingSecondStep) return "Broken";
  if (v.open) return "Open";
  if (v.pending || v.trusted) return "Waiting";
  if (v.header) return "Locked";
  return "Empty";
};

export const colors = {
  Empty: "blue",
  Locked: "orange",
  Waiting: "purple",
  Open: "yellow",
  Broken: "pink",
};

export const title = "How the vault unlocks";
